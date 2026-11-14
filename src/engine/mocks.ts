import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import type { MockResult, ShellMocks } from "./config.ts";
import type { InteractionRecord, MockWiring } from "./registry.ts";

/** How long closing waits for already connected callers before dropping them. */
const CLOSE_GRACE_MS = 5_000;
/** Any sandboxed process can connect and send; argv itself is limited to about 256 KiB. */
const MAX_CALL_BYTES = 1_000_000;

// One forwarder for every mocked command: it sends the call over the run's socket, then
// reads the reply line by line. The name it was executed under selects the target.
// The reply is read from the pipe rather than captured, because command substitution strips
// the trailing newlines that make an empty stdout or stderr distinguishable.
const FORWARDER = `#!/bin/sh
self=$0
socket=__SOCKET__
encode() {
  printf '%s' "$1" | /usr/bin/base64 | /usr/bin/tr -d '\\n'
  printf '\\n'
}
{
  encode "$self"
  for argument in "$@"; do
    encode "$argument"
  done
} | /usr/bin/nc -U "$socket" | {
  IFS= read -r code || {
    printf '%s: Service unavailable\\n' "\${self##*/}" >&2
    exit 126
  }
  IFS= read -r out
  IFS= read -r err
  if [ -n "$out" ]; then printf '%s' "$out" | /usr/bin/base64 -D; fi
  if [ -n "$err" ]; then printf '%s' "$err" | /usr/bin/base64 -D >&2; fi
  exit "$code"
}
exit $?
`;

export interface MockHost {
  /** What the runner places in its environment. */
  readonly wiring: MockWiring;
  /** Stop accepting and answering calls, then return every call that arrived. */
  readonly close: () => Promise<readonly InteractionRecord[]>;
}

/**
 * Write the forwarders and answer their calls outside the sandbox. The caller starts this
 * before the runner and closes it after the runner has stopped, so no call is cut short.
 */
export async function startMockHost(options: {
  readonly runRootDir: string;
  readonly shell: ShellMocks;
}): Promise<MockHost> {
  const forwarderDir = join(options.runRootDir, "bin");
  // A Unix socket path is limited to about 100 bytes, so it cannot live under the run root.
  const socketPath = join(tmpdir(), `${basename(options.runRootDir)}.sock`);
  const scriptPath = join(options.runRootDir, "forward");
  await mkdir(forwarderDir, { mode: 0o700 });
  await writeFile(scriptPath, FORWARDER.replace("__SOCKET__", quote(socketPath)), {
    mode: 0o500,
    flag: "wx",
  });
  for (const target of Object.keys(options.shell).sort()) {
    await link(scriptPath, join(forwarderDir, target));
  }

  const results = new Map(Object.entries(options.shell));
  const interactions: InteractionRecord[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
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
    socket.on("end", () => answer(socket, Buffer.concat(chunks), results, interactions));
  });
  await listen(server, socketPath);

  return {
    wiring: { forwarderDir, socketPath },
    async close() {
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
      return [...interactions];
    },
  };
}

/**
 * Decode one call and reply with the fixed result. Anything connected to the socket can send
 * arbitrary bytes, so an unreadable or unterminated message is denied instead of recorded.
 */
function answer(
  socket: Socket,
  message: Buffer,
  results: ReadonlyMap<string, MockResult>,
  interactions: InteractionRecord[],
): void {
  const lines = message.toString("utf8").split("\n");
  if (lines.pop() !== "" || lines.length === 0) {
    socket.end(denied(""));
    return;
  }
  const target = basename(decode(lines[0] as string));
  const result = results.get(target);
  if (result === undefined) {
    socket.end(denied(target));
    return;
  }
  interactions.push({ target, arguments: lines.slice(1).map(decode) });
  socket.end(`${result.exitCode}\n${encode(result.stdout)}\n${encode(result.stderr)}\n`);
}

function denied(target: string): string {
  return `126\n\n${encode(`${target === "" ? "call" : target}: Operation not permitted\n`)}\n`;
}

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
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
