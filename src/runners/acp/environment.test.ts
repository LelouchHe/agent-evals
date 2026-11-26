import assert from "node:assert/strict";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { resolveDeniedExecutables } from "../../platform/index.ts";

test("resolved denied executables cover PATH matches under both spelling and realpath", async (t) => {
  const root = await makeTempDir(t, "ae-denied-");
  const homeBin = join(root, "bin");
  await mkdir(homeBin);
  const toolPath = join(homeBin, "tool");
  await writeFile(toolPath, "#!/bin/sh\n");
  await chmod(toolPath, 0o755);

  const denied = new Set(await resolveDeniedExecutables(["tool", "absent"], [homeBin]));
  assert.ok(denied.has(toolPath), toolPath);
  assert.ok(denied.has(await realpath(toolPath)), toolPath);
});
