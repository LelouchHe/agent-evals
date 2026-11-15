import assert from "node:assert/strict";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { deniedBinaries } from "./environment.ts";

test("denied binaries cover the PATH match and the developer directory copy", async (t) => {
  const root = await makeTempDir(t, "ae-denied-");
  const homeBin = join(root, "bin");
  const developer = join(root, "developer");
  await mkdir(homeBin);
  await mkdir(join(developer, "usr/bin"), { recursive: true });
  for (const path of [join(homeBin, "tool"), join(developer, "usr/bin/tool")]) {
    await writeFile(path, "#!/bin/sh\n");
    await chmod(path, 0o755);
  }

  const denied = new Set(await deniedBinaries(["tool", "absent"], [homeBin], developer));
  // Each match is denied under both its PATH spelling and its physical path.
  for (const path of [join(homeBin, "tool"), join(developer, "usr/bin/tool")]) {
    assert.ok(denied.has(path), path);
    assert.ok(denied.has(await realpath(path)), path);
  }
  assert.equal(denied.size, 4);
});
