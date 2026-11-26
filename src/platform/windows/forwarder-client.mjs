import { spawnSync } from "node:child_process";
import { appendFileSync, realpathSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

/**
 * Windows mock forwarder client.
 *
 * Invoked by `forwarder.cmd` as:
 *   node forwarder-client.mjs <bindir> <endpoint> <fault> <self> [...args]
 *
 * Reports the canonicalised invocation path and arguments over the host's authenticated
 * loopback TCP endpoint. For mocked results, replays stdout/stderr directly and exits with
 * the mocked code. For `pass`, runs the resolved real executable with inherited stdio.
 */

const [bindir, endpoint, faultPath, rawSelf, ...args] = process.argv.slice(2);
if (bindir === undefined || endpoint === undefined || faultPath === undefined || rawSelf === undefined) {
  process.exit(126);
}

const self = canonicalSelf(rawSelf);
const inBinDir = self.toLowerCase().startsWith(`${bindir.toLowerCase()}${sep}`);
const name = inBinDir && self.toLowerCase().endsWith(".cmd") ? basename(self).slice(0, -4) : basename(self);

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

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findPassTarget() {
  if (inBinDir) {
    const extensions = ["", ".exe", ".cmd", ".bat", ".com"];
    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
      if (folder.length === 0) continue;
      for (const ext of extensions) {
        const candidate = resolve(folder, `${name}${ext}`);
        if (!isRegularFile(candidate)) continue;
        const canonical = canonicalSelf(candidate).toLowerCase();
        if (canonical === self.toLowerCase() || canonical.startsWith(`${bindir.toLowerCase()}${sep}`)) continue;
        return candidate;
      }
    }
    return undefined;
  }
  const real = resolve(dirname(self), `.${basename(self)}`);
  return isRegularFile(real) ? real : undefined;
}

function runPass() {
  const target = findPassTarget();
  if (target === undefined) {
    process.stderr.write(`${name}: Operation not permitted\n`);
    process.exitCode = 126;
    return;
  }
  const isPs1 = target.toLowerCase().endsWith(".ps1");
  const res = isPs1
    ? spawnSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "None", "-File", target, ...args],
        { stdio: "inherit", windowsHide: true },
      )
    : spawnSync(target, args, {
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
}

function parseEndpoint(value) {
  if (!value.startsWith("tcp://127.0.0.1:")) return undefined;
  const rest = value.slice("tcp://127.0.0.1:".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return undefined;
  const port = Number(rest.slice(0, slash));
  const nonce = rest.slice(slash + 1);
  if (!Number.isInteger(port) || port <= 0 || nonce.length === 0) return undefined;
  return { port, nonce };
}

const parsed = parseEndpoint(endpoint);
if (parsed === undefined) {
  failUnavailable();
  process.exit(126);
}

const socket = createConnection({ host: "127.0.0.1", port: parsed.port });
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

const payload = [`nonce:${parsed.nonce}`, self, ...args].map(encode).join("\n") + "\n";
socket.end(payload);
