import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, realpathSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";

/**
 * Cross-platform mock forwarder client.
 *
 * Invoked by a tiny POSIX shell wrapper as:
 *   node forwarder-client.mjs <bindir> <socket> <fault> <self> [...args]
 *
 * Reports the canonicalised invocation path and arguments to the engine's host socket over
 * a half-closed Unix domain connection, then either replays the host's mocked result or runs
 * the real command on `pass`.
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
  process.exit(126);
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
      const candidate = join(folder, name);
      if (!isExecutableFile(candidate)) continue;
      if (canonicalSelf(candidate) === self) continue;
      return candidate;
    }
    return undefined;
  }
  const real = join(dirname(self), `.${name}`);
  return isExecutableFile(real) ? real : undefined;
}

function runPass() {
  const target = findPassTarget();
  if (target === undefined) {
    process.stderr.write(`${name}: Operation not permitted\n`);
    process.exit(126);
  }
  const result = spawnSync(target, args, { stdio: "inherit" });
  if (result.error !== undefined) {
    process.stderr.write(`${name}: Operation not permitted\n`);
    process.exit(126);
  }
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
}

const socket = createConnection(socketPath);
const chunks = [];
let settled = false;

socket.on("error", () => {
  if (settled) return;
  settled = true;
  failUnavailable();
});

socket.on("data", (chunk) => {
  chunks.push(chunk);
});

socket.on("end", () => {
  if (settled) return;
  settled = true;
  const reply = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (reply.length === 0) failUnavailable();
  const [kind, codeText, outText, errText] = reply.split(" ");
  if (kind === "pass") {
    runPass();
  }
  const code = Number(codeText);
  if (!Number.isInteger(code)) failUnavailable();
  if (outText !== undefined && outText !== "" && outText !== "-") {
    process.stdout.write(Buffer.from(outText, "base64"));
  }
  if (errText !== undefined && errText !== "" && errText !== "-") {
    process.stderr.write(Buffer.from(errText, "base64"));
  }
  process.exit(code);
});

const payload = [self, ...args].map(encode).join("\n") + "\n";
socket.end(payload);
