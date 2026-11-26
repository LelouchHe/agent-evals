import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(root, "tests");
const passthrough = process.argv.slice(2);

function isPlatformAllowed(relPosix) {
  if (relPosix.startsWith("macos/")) return process.platform === "darwin";
  if (relPosix.startsWith("linux/")) return process.platform === "linux";
  if (relPosix.startsWith("windows/")) return process.platform === "win32";
  if (relPosix.startsWith("posix/")) return process.platform === "darwin" || process.platform === "linux";
  return true;
}

function collectTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "helpers" || entry.name === "types") continue;
      collectTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      const rel = relative(testsRoot, full).split(sep).join("/");
      if (isPlatformAllowed(rel)) out.push(full);
    }
  }
  return out.sort();
}

const files = passthrough.length > 0 ? passthrough : collectTestFiles(testsRoot);
const result = spawnSync(process.execPath, ["--test", "--test-timeout=30000", ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
