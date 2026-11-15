import { spawn, type ChildProcess } from "node:child_process";
import { link, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
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

export interface MockShellOptions {
  readonly runRootDir: string;
  /** Prepared workspace root; its real path, as the runner's sandbox sees it. */
  readonly workspaceDir: string;
  readonly shell: ShellMocks;
}

export interface MockListenOptions {
  /** Directory of the case file, the working directory of `run` programs. */
  readonly authoringDir: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Forwarders written, listeners not yet open: only a failure-free step separates the two. */
export interface MockPreparation {
  readonly wiring: MockWiring;
  /** Start answering calls. Call after the workspace baseline exists. */
  readonly listen: (options: MockListenOptions) => Promise<MockHost>;
}

/**
 * Write every forwarder, workspace scripts included, so the caller can snapshot the baseline.
 * Nothing listens yet: the preparation that can fail leaves no open socket behind.
 */
export async function prepareMockShell(options: MockShellOptions): Promise<MockPreparation> {
  const forwarderDir = join(options.runRootDir, "bin");
  // A Unix socket path is limited to about 100 bytes, so it cannot live under the run root.
  const socketPath = join(tmpdir(), `${basename(options.runRootDir)}.sock`);
  const faultSocketPath = join(tmpdir(), `${basename(options.runRootDir)}.fault.sock`);
  const scriptPath = join(options.runRootDir, "forward");
  const rules = compileShellMocks(options.shell);
  const workspaceRoot = await openRunRoot(options.workspaceDir);
  await mkdir(forwarderDir, { mode: 0o700 });
  // The forwarder canonicalises its own path, so identity comparisons use the real directory.
  const forwarderRoot = await realpath(forwarderDir);

  const forwarder = (await readFile(FORWARDER_ASSET, "utf8"))
    .replace("__BINDIR__", quote(forwarderRoot))
    .replace("__SOCKET__", quote(socketPath))
    .replace("__FAULTSOCK__", quote(faultSocketPath));
  await writeFile(scriptPath, forwarder, { mode: 0o500, flag: "wx" });

  for (const target of Object.keys(options.shell).sort()) {
    if (target.includes("/")) {
      await placeWorkspaceForwarder(workspaceRoot.path, options, target, forwarder);
    } else {
      await link(scriptPath, join(forwarderDir, target));
    }
  }

  const wiring: MockWiring = { forwarderDir, socketPath, denyTargets: denyTargetsOf(options.shell) };
  return {
    wiring,
    listen: (listenOptions) =>
      listenMockHost({
        wiring,
        faultSocketPath,
        rules,
        forwarderRoot,
        workspaceDir: workspaceRoot.path,
        signal: listenOptions.signal,
        runOptions: {
          authoringDir: listenOptions.authoringDir,
          timeoutMs: listenOptions.timeoutMs,
          signal: listenOptions.signal,
        },
      }),
  };
}

/** Prepare and immediately start the host, for callers with no step in between. */
export async function startMockHost(options: MockShellOptions & MockListenOptions): Promise<MockHost> {
  const preparation = await prepareMockShell(options);
  return preparation.listen(options);
}

interface ListenInput {
  readonly wiring: MockWiring;
  readonly faultSocketPath: string;
  readonly rules: CompiledShellMocks;
  readonly forwarderRoot: string;
  readonly workspaceDir: string;
  readonly signal: AbortSignal;
  readonly runOptions: MockListenOptions;
}

async function listenMockHost(input: ListenInput): Promise<MockHost> {
  const { wiring, rules, forwarderRoot, workspaceDir, runOptions } = input;
  const records: MockRecord[] = [];
  const faults: string[] = [];
  /** Process-group leaders still owning descendants we must not leave behind. */
  const groups = new Set<number>();
  const sockets = new Set<Socket>();

  // The forwarder half-closes after sending, then reads the reply: keep the writable side open
  // until the answer (which may await a run program) has been written.
  const server = accepting((socket) => {
    readRequest(socket, (message) => {
      void answer(socket, message).catch((error: unknown) => {
        faults.push(`failed to answer a call: ${errorMessage(error)}`);
        socket.end(denied(""));
      });
    });
  });
  // A forwarder that cannot reach the call socket reports it here, outside the sandbox, so a
  // fault cannot be erased from the evaluated side.
  const faultServer = accepting((socket) => {
    readRequest(socket, (message) => {
      const lines = message.toString("utf8").split("\n");
      const self = lines.length > 0 ? decode(lines[0] as string) : "";
      const call = self.length === 0 ? undefined : resolveCall(self, forwarderRoot, workspaceDir, rules);
      faults.push(
        `a forwarder for "${call?.target ?? (self === "" ? "a call" : basename(self))}" could not reach the mock host`,
      );
      socket.end("");
    });
  });
  await listen(server, wiring.socketPath);
  await listen(faultServer, input.faultSocketPath);

  function readRequest(socket: Socket, onMessage: (message: Buffer) => void): void {
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
    socket.on("end", () => onMessage(Buffer.concat(chunks)));
  }

  async function answer(socket: Socket, message: Buffer): Promise<void> {
    const lines = message.toString("utf8").split("\n");
    if (lines.pop() !== "" || lines.length === 0) {
      socket.end(denied(""));
      return;
    }
    const call = resolveCall(decode(lines[0] as string), forwarderRoot, workspaceDir, rules);
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
    if (action.kind === "return") {
      return resultReply(
        action.result.exitCode,
        Buffer.from(action.result.stdout, "utf8"),
        Buffer.from(action.result.stderr, "utf8"),
      );
    }
    const program = await runProgram(target, action, argv, groups, runOptions);
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
    await Promise.all([closeServer(server), closeServer(faultServer)]);
    for (const socket of sockets) socket.destroy();
    await rm(wiring.socketPath, { force: true });
    await rm(input.faultSocketPath, { force: true });
    return { records: [...records], faults: [...faults] };
  }

  return { wiring, close };
}

/** Close a listener, but not at the price of hanging on a caller that never disconnects. */
async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const grace = new AbortController();
  try {
    await Promise.race([closed, delay(CLOSE_GRACE_MS, undefined, { signal: grace.signal })]);
  } finally {
    grace.abort();
  }
  await closed;
}

function accepting(handler: (socket: Socket) => void): Server {
  return createServer({ allowHalfOpen: true }, handler);
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
  options: MockShellOptions,
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
    const stash = join(options.runRootDir, "replaced", ...target.split("/").filter((segment) => segment.length > 0));
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
  options: MockListenOptions,
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
