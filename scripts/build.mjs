import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

await rm(dist, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { cwd: root, stdio: "inherit" });

// Non-TypeScript runtime assets are copied unchanged into their compiled location.
for (const asset of ["engine/forwarder.sh", "runners/pi/shell-wrapper.sh"]) {
  const target = join(dist, asset);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, "src", asset), target);
}

const cli = join(dist, "cli.js");
const source = await readFile(cli, "utf8");
if (!source.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("built dist/cli.js is missing its Node.js shebang");
}
await chmod(cli, 0o755);
