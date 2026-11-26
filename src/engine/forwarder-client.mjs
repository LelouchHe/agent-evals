import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, realpathSync, statSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

/**
 * Cross-platform mock forwarder client.
 *
 * Invoked by `forwarder.sh` as:
 *   node forwarder-client.mjs <bindir> <socket> <fault> <self> [...args] 4>&1 1>&3
 *
 * Reports the canonicalised invocation path and arguments to the engine's host socket over
 * a half-closed Unix domain connection. For mocked results, replays stdout/stderr directly to
 * FDs 1/2 and exits with the mocked code. For `pass`, writes the resolved absolute target path
 * to FD 4 so `forwarder.sh` replaces itself with `exec "$target" "$@"`.
 */

const [bindir, socketPath, faultPath, rawSelf, ...args] = process.argv.slice(2);
if (bindir === undefined || socketPath === undefined || faultPath === undefined || rawSelf === undefined) {
  process.exit(126);
}

const isWindows = process.platform === "win32";
const self = canonicalSelf(rawSelf);
const inBinDir = isWindows
  ? self.toLowerCase().startsWith(`${bindir.toLowerCase()}${sep}`)
  : self.startsWith(`${bindir}/`);
const name =
  isWindows && inBinDir && self.toLowerCase().endsWith(".cmd") ? basename(self).slice(0, -4) : basename(self);

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
    if (!isWindows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function samePath(a, b) {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function findPassTarget() {
  if (inBinDir) {
    const extensions = isWindows ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];
    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
      if (folder.length === 0) continue;
      for (const ext of extensions) {
        // Resolve to an absolute path so relative entries such as `.` never trigger a PATH re-lookup.
        const candidate = resolve(folder, `${name}${ext}`);
        if (!isExecutableFile(candidate)) continue;
        if (samePath(canonicalSelf(candidate), self)) continue;
        return candidate;
      }
    }
    return undefined;
  }
  const real = resolve(dirname(self), `.${basename(self)}`);
  return isExecutableFile(real) ? real : undefined;
}

function runPass() {
  const target = findPassTarget();
  if (target === undefined) {
    process.stderr.write(`${name}: Operation not permitted\n`);
    process.exitCode = 126;
    return;
  }
  if (isWindows) {
    const res = spawnSync(target, args, {
      stdio: "inherit",
      shell: /\.(?:cmd|bat)$/iu.test(target),
      windowsHide: true,
    });
    if (res.error !== undefined) {
      process.stderr.write(`${name}: ${res.error.message}\n`);
      process.exitCode = 126;
    } else {
      process.exitCode = res.status ?? 1;
    }
    return;
  }
  writeSync(4, target);
  process.exitCode = 0;
}

function openTransport(endpoint) {
  if (endpoint.startsWith("tcp://127.0.0.1:")) {
    const rest = endpoint.slice("tcp://127.0.0.1:".length);
    const slash = rest.indexOf("/");
    const port = Number(slash === -1 ? rest : rest.slice(0, slash));
    const nonce = slash === -1 ? undefined : rest.slice(slash + 1);
    return { socket: createConnection({ host: "127.0.0.1", port }), nonce };
  }
  return { socket: createConnection(endpoint), nonce: undefined };
}

const { socket, nonce } = openTransport(socketPath);
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
  // Leave the event loop to drain stdout/stderr naturally before exiting.
  process.exitCode = code;
});

const payloadLines = nonce === undefined ? [self, ...args] : [`nonce:${nonce}`, self, ...args];
const payload = payloadLines.map(encode).join("\n") + "\n";
socket.end(payload);
