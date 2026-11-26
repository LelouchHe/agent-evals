import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

await rm(dist, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { cwd: root, stdio: "inherit" });

// Non-TypeScript runtime assets are copied unchanged into their compiled location.
for (const asset of [
  "platform/posix-forwarder.sh",
  "platform/posix-forwarder-client.mjs",
  "platform/windows/forwarder.cmd",
  "platform/windows/forwarder.ps1",
  "platform/windows/forwarder.sh",
  "platform/windows/forwarder-client.mjs",
  "platform/windows/setup.ps1",
  "platform/macos/supervisor.sh",
  "runners/pi/shell-wrapper.sh",
]) {
  const target = join(dist, asset);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, "src", asset), target);
}

// Declaration files keep the source's `.ts` specifiers, which a consumer's TypeScript only
// resolves by extension substitution. Emit `.js` so the published types use the same specifiers
// as the JavaScript beside them.
for (const file of await declarationFiles(dist)) {
  const source = await readFile(file, "utf8");
  const rewritten = source.replace(/(from\s*|import\()(["'])(\.[^"']*?)\.ts\2/g, "$1$2$3.js$2");
  if (rewritten !== source) await writeFile(file, rewritten);
}

const cli = join(dist, "cli.js");
const source = await readFile(cli, "utf8");
if (!source.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("built dist/cli.js is missing its Node.js shebang");
}
await chmod(cli, 0o755);

/** Every `.d.ts` beneath a directory. */
async function declarationFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await declarationFiles(path)));
    else if (entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}
