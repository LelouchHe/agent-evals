import { accessSync, appendFileSync, constants, realpathSync, statSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

/**
 * POSIX mock forwarder client.
 *
 * Invoked by `forwarder.sh` as:
 *   node posix-forwarder-client.mjs <bindir> <socket> <fault> <self> [...args] 4>&1 1>&3
 *
 * Reports the canonicalised invocation path and arguments to the engine's host Unix socket.
 * For mocked results, replays stdout/stderr directly to FDs 1/2 and exits with the mocked code.
 * For `pass`, writes the resolved absolute target path to FD 4 so `forwarder.sh` replaces itself
 * with `exec "$target" "$@"`.
 */

const [bindir, socketPath, faultPath, rawSelf, ...args] = process.argv.slice(2);
if (bindir === undefined || socketPath === undefined || faultPath === undefined || rawSelf === undefined) {
  process.exit(126);
}

const self = canonicalSelf(rawSelf);
const name = basename(self);

function canonicalSelf(path) {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function failUnavailable() {
  process.stderr.write(`${name}: Service unavailable\n`);
  try {
    appendFileSync(faultPath, `${name}\n`);
  } catch {
    // Fault log is best-effort when the temporary directory is inaccessible.
  }
  process.exitCode = 126;
}

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findPassTarget() {
  if (self.startsWith(`${bindir}/`)) {
    for (const folder of (process.env.PATH ?? "").split(":")) {
      if (folder.length === 0) continue;
      const candidate = resolve(folder, name);
      if (!isExecutableFile(candidate)) continue;
      if (canonicalSelf(candidate) === self) continue;
      return candidate;
    }
    return undefined;
  }
  const real = resolve(dirname(self), `.${name}`);
  return isExecutableFile(real) ? real : undefined;
}

function runPass() {
  const target = findPassTarget();
  if (target === undefined) {
    process.stderr.write(`${name}: Operation not permitted\n`);
    process.exitCode = 126;
    return;
  }
  writeSync(4, target);
  process.exitCode = 0;
}

const socket = createConnection(socketPath);
const chunks = [];
let settled = false;

socket.on("error", () => {
  if (settled) return;
  settled = true;
  socket.destroy();
  failUnavailable();
});

socket.on("data", (chunk) => {
  chunks.push(chunk);
});

socket.on("end", () => {
  if (settled) return;
  settled = true;
  socket.destroy();
  const reply = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (reply.length === 0) {
    failUnavailable();
    return;
  }
  const [kind, codeText, outText, errText] = reply.split(" ");
  if (kind === "pass") {
    runPass();
    return;
  }
  const code = Number(codeText);
  if (!Number.isInteger(code)) {
    failUnavailable();
    return;
  }
  if (outText !== undefined && outText !== "" && outText !== "-") {
    process.stdout.write(Buffer.from(outText, "base64"));
  }
  if (errText !== undefined && errText !== "" && errText !== "-") {
    process.stderr.write(Buffer.from(errText, "base64"));
  }
  process.exitCode = code;
});

const payload = [self, ...args].map(encode).join("\n") + "\n";
socket.end(payload);
