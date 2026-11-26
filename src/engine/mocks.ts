import { spawn, type ChildProcess } from "node:child_process";
import { link, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ConfigError, errorMessage, type MockAction, type ShellMocks } from "./config.ts";
import { compileShellMocks, matchCall, type CompiledRules, type CompiledShellMocks } from "./mock-match.ts";
import type { MockRecord, MockWiring } from "./registry.ts";
import { isMissing, isWithin, openRunRoot, resolveWorkspacePath } from "./workspace.ts";

/** How long closing waits for already connected callers before dropping them. */
const CLOSE_GRACE_MS = 5_000;
/** Any sandboxed process can connect and send; argv itself is limited to about 256 KiB. */
const MAX_CALL_BYTES = 1_000_000;
/** The complete stdout of a `run` program that hands the call to the real command. */
const PASS_MARKER = Buffer.from("agent-evals:pass");
const PASS_MARKER_LINE = Buffer.from("agent-evals:pass\n");
const EMPTY = Buffer.alloc(0);

// The forwarder is a POSIX shell asset beside this module, copied unchanged by the build, so
// source and built runs read one text. It reports the call over the run's socket and reads the
// reply from a single line: capturing the reply would strip the trailing newlines that make an
// empty stdout or stderr distinguishable. The name it is executed under selects the target.
const FORWARDER_ASSET = new URL("./forwarder.sh", import.meta.url);
const FORWARDER_CLIENT = fileURLToPath(new URL("./forwarder-client.mjs", import.meta.url));

export interface MockOutcome {
  /** Every recorded call, in arrival order. */
  readonly records: readonly MockRecord[];
  /** Infrastructure faults, such as a run program that could not start. */
  readonly faults: readonly string[];
}

export interface MockHost {
  /** What the runner places in its environment. */
  readonly wiring: MockWiring;
  /** Stop answering calls, then return every recorded call and fault. Safe to call again. */
  readonly close: () => Promise<MockOutcome>;
}

export interface MockHostOptions {
  readonly runRootDir: string;
  /** Engine-private state; the replaced workspace scripts move here, out of the agent's reach. */
  readonly engineDir: string;
  /** Read-only forwarder directory the runner puts first on `PATH`. */
  readonly mocksDir: string;
  /** Prepared workspace root; its real path, as the runner's sandbox sees it. */
  readonly workspaceDir: string;
  /** Temporary directory; a forwarder that cannot reach the host reports there. */
  readonly tmpDir: string;
  /** Directory of the case file, the working directory of `run` programs. */
  readonly authoringDir: string;
  readonly shell: ShellMocks;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Write every forwarder, workspace scripts included, and start answering calls. The caller
 * runs this before the baseline snapshot, so the snapshot already holds the forwarders.
 */
export async function startMockHost(options: MockHostOptions): Promise<MockHost> {
  const forwarderDir = options.mocksDir;
  // A Unix socket path is limited to about 100 bytes, so it cannot live under the run root.
  const socketPath = join(tmpdir(), `${basename(options.runRootDir)}.sock`);
  const faultPath = join(options.tmpDir, ".forward-fault");
  // The template lives in engine-private state; only its hard links are runnable in mocks/.
  const scriptPath = join(options.engineDir, "forward");
  const rules = compileShellMocks(options.shell);
  const workspaceRoot = await openRunRoot(options.workspaceDir);
  await mkdir(forwarderDir, { recursive: true, mode: 0o700 });
  // The forwarder canonicalises its own path, so identity comparisons use the real directory.
  const forwarderRoot = await realpath(forwarderDir);

  const nodeExecutable = await realpath(process.execPath);
  const clientPath = await realpath(FORWARDER_CLIENT);

  const replacements: Readonly<Record<string, string>> = {
    __NODE__: quote(nodeExecutable),
    __CLIENT__: quote(clientPath),
    __BINDIR__: quote(forwarderRoot),
    __SOCKET__: quote(socketPath),
    __FAULT__: quote(faultPath),
  };
  const forwarder = (await readFile(FORWARDER_ASSET, "utf8")).replace(
    /__NODE__|__CLIENT__|__BINDIR__|__SOCKET__|__FAULT__/g,
    (token) => replacements[token]!,
  );
  await writeFile(scriptPath, forwarder, { mode: 0o500, flag: "wx" });

  for (const target of Object.keys(options.shell).sort()) {
    if (target.includes("/")) {
      await placeWorkspaceForwarder(workspaceRoot.path, options, target, forwarder);
    } else {
      await link(scriptPath, join(forwarderDir, target));
    }
  }

  const wiring: MockWiring = {
    forwarderDir,
    socketPath,
    denyTargets: denyTargetsOf(options.shell),
    readableFiles: [nodeExecutable, clientPath],
  };
  const records: MockRecord[] = [];
  const faults: string[] = [];
  /** Process-group leaders still owning descendants we must not leave behind. */
  const groups = new Set<number>();
  const sockets = new Set<Socket>();

  // The forwarder half-closes after sending, then reads the reply: keep the writable side open
  // until the answer (which may await a run program) has been written.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CALL_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      void answer(socket, Buffer.concat(chunks)).catch((error: unknown) => {
        faults.push(`failed to answer a call: ${errorMessage(error)}`);
        socket.end(denied(""));
      });
    });
  });
  await listen(server, socketPath);

  async function answer(socket: Socket, message: Buffer): Promise<void> {
    const lines = message.toString("utf8").split("\n");
    if (lines.pop() !== "" || lines.length === 0) {
      socket.end(denied("call"));
      return;
    }
    const call = resolveCall(decode(lines[0] as string), forwarderRoot, workspaceRoot.path, rules);
    if (call === undefined) {
      socket.end(denied("call"));
      return;
    }
    const argv = lines.slice(1).map(decode);
    records.push({ target: call.target, arguments: argv });
    const action = matchCall(call.rules, argv);
    socket.end(action === undefined ? denied(call.target) : await reply(action, call.target, argv));
  }

  async function reply(action: MockAction, target: string, argv: readonly string[]): Promise<string> {
    if (action.kind === "pass") return passReply();
    // An explicit refusal is a decision, like an unmatched call: recorded, never a fault.
    if (action.kind === "refuse") return denied(target);
    if (action.kind === "return") {
      return resultReply(
        action.result.exitCode,
        Buffer.from(action.result.stdout, "utf8"),
        Buffer.from(action.result.stderr, "utf8"),
      );
    }
    const program = await runProgram(target, action, argv, groups, options);
    if (program.fault !== undefined) {
      faults.push(program.fault);
      return denied(target);
    }
    if (program.stdout.equals(PASS_MARKER) || program.stdout.equals(PASS_MARKER_LINE)) {
      if (!action.pass) {
        faults.push(`run program for "${target}" printed the pass marker but the rule has no pass`);
        return denied(target);
      }
      if (program.exitCode !== 0) {
        faults.push(`run program for "${target}" printed the pass marker with exit code ${program.exitCode}`);
        return denied(target);
      }
      return passReply();
    }
    // Any other bytes, the marker included, are the program's response: data, not a control.
    return resultReply(program.exitCode, program.stdout, program.stderr);
  }

  let closing: Promise<MockOutcome> | undefined;
  const close = (): Promise<MockOutcome> => (closing ??= shutdown());

  async function shutdown(): Promise<MockOutcome> {
    for (const pid of groups) killGroupPid(pid);
    groups.clear();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const grace = new AbortController();
    try {
      await Promise.race([closed, delay(CLOSE_GRACE_MS, undefined, { signal: grace.signal })]);
    } finally {
      grace.abort();
    }
    for (const socket of sockets) socket.destroy();
    await closed;
    await rm(socketPath, { force: true });
    faults.push(...(await transportFaults(faultPath)));
    return { records: [...records], faults: [...faults] };
  }

  return { wiring, close };
}

/** PATH targets without any `pass` rule, whose real binaries the runner must deny. */
function denyTargetsOf(shell: ShellMocks): readonly string[] {
  return Object.entries(shell)
    .filter(
      ([target, rules]) =>
        !target.includes("/") &&
        !rules.some((rule) => rule.action.kind === "pass" || (rule.action.kind === "run" && rule.action.pass)),
    )
    .map(([target]) => target)
    .sort();
}

interface ResolvedCall {
  readonly target: string;
  readonly rules: CompiledRules;
}

/**
 * A call is identified by where its forwarder lives: directly in the run's forwarder directory,
 * or at its workspace-relative path. A bare name and `./name` are different targets: a `PATH`
 * command and a workspace-root script.
 */
function resolveCall(
  self: string,
  forwarderRoot: string,
  workspaceDir: string,
  rules: CompiledShellMocks,
): ResolvedCall | undefined {
  if (dirname(self) === forwarderRoot) {
    const name = basename(self);
    const targetRules = rules.path.get(name);
    return targetRules === undefined ? undefined : { target: name, rules: targetRules };
  }
  if (isWithin(workspaceDir, self)) {
    const path = relative(workspaceDir, self).split(sep).join("/");
    const target = rules.workspace.get(path);
    return target === undefined ? undefined : { target: target.target, rules: target.rules };
  }
  return undefined;
}

/**
 * Place one workspace forwarder before the baseline snapshot. A target with a `pass` rule keeps
 * its real script beside it under a dot-prefixed name; without `pass` the real script leaves the
 * sandbox entirely, so only the forwarder is runnable.
 */
async function placeWorkspaceForwarder(
  workspaceDir: string,
  options: MockHostOptions,
  target: string,
  forwarder: string,
): Promise<void> {
  const root = await openRunRoot(workspaceDir);
  const targetPath = await resolveWorkspacePath(root, target);
  const folder = dirname(targetPath);
  const real = await stat(targetPath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (real?.isDirectory() === true) {
    throw new ConfigError(`mocked workspace script ${target} is a directory`);
  }
  const usesPass = options.shell[target]?.some(
    (rule) => rule.action.kind === "pass" || (rule.action.kind === "run" && rule.action.pass),
  );
  if (usesPass) {
    if (real === undefined) {
      throw new ConfigError(`mocked workspace script ${target} needs a real script for its pass rule`);
    }
    const beside = join(folder, `.${basename(targetPath)}`);
    try {
      await stat(beside);
      throw new ConfigError(`mocked workspace script ${target} already has ${basename(beside)} beside it`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await rename(targetPath, beside);
  } else if (real !== undefined) {
    const stash = join(options.engineDir, "replaced", ...target.split("/").filter((segment) => segment.length > 0));
    await mkdir(dirname(stash), { recursive: true, mode: 0o700 });
    await rename(targetPath, stash);
  }
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(targetPath, forwarder, { mode: 0o500, flag: "wx" });
}

interface RunOutcome {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly fault?: string;
}

/**
 * Start the author's program with the call's arguments appended, without a shell, in the case
 * directory and with empty stdin. A program that cannot start, dies from a signal or exceeds the
 * run's deadline is an infrastructure fault; an ordinary nonzero exit is just a response.
 * Stdout and stderr stay opaque bytes.
 */
async function runProgram(
  target: string,
  action: Extract<MockAction, { kind: "run" }>,
  argv: readonly string[],
  groups: Set<number>,
  options: MockHostOptions,
): Promise<RunOutcome> {
  const [program, ...prefix] = action.command;
  const child = spawn(program as string, [...prefix, ...argv], {
    cwd: options.authoringDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const pid = child.pid;
  if (pid !== undefined) groups.add(pid);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child);
  }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    killGroup(child);
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome = await new Promise<
      { readonly code: number | null; readonly signal: NodeJS.Signals | null } | { readonly error: Error }
    >((resolve) => {
      child.once("error", (error: Error) => resolve({ error }));
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
    });
    const failed = (fault: string): RunOutcome => ({ exitCode: 126, stdout: EMPTY, stderr: EMPTY, fault });
    if ("error" in outcome) return failed(`could not start ${program} for "${target}": ${outcome.error.message}`);
    if (timedOut) return failed(`run program for "${target}" exceeded ${options.timeoutMs}ms`);
    if (aborted) return failed(`run program for "${target}" was stopped by cancellation`);
    if (outcome.signal !== null) return failed(`run program for "${target}" was killed by ${outcome.signal}`);
    return {
      exitCode: outcome.code ?? 126,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
    // The leader can exit while descendants live on in its process group; leave none behind.
    killGroup(child);
    if (pid !== undefined) groups.delete(pid);
  }
}

/** Kill a run program's process group, including descendants that outlived its leader. */
function killGroupPid(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function killGroup(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  if (child.pid !== undefined) killGroupPid(child.pid);
}

/** Faults a forwarder wrote when it could not reach the call socket. */
async function transportFaults(path: string): Promise<readonly string[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => `a forwarder for "${line}" could not reach the mock host`);
  } catch {
    return [];
  }
}

function resultReply(exitCode: number, stdout: Buffer, stderr: Buffer): string {
  return `result ${exitCode} ${field(stdout)} ${field(stderr)}\n`;
}

function passReply(): string {
  return "pass 0 - -\n";
}

function denied(target: string): string {
  return resultReply(126, EMPTY, Buffer.from(`${target}: Operation not permitted\n`, "utf8"));
}

/** A reply field is never empty, so a stripped trailing newline cannot merge two fields. */
function field(bytes: Buffer): string {
  return bytes.length === 0 ? "-" : bytes.toString("base64");
}

/** Quote a value as one POSIX shell word. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function decode(line: string): string {
  return Buffer.from(line, "base64").toString("utf8");
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
