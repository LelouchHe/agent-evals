import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { IgnoreTree, isIgnored } from "./ignore.ts";

test("an ignore file that is not a regular file is a configuration error, not no rules", async (t) => {
  const dir = await makeTempDir(t, "ae-ignore-");
  await mkdir(join(dir, ".agentevalsignore"));

  await assert.rejects(isIgnored(new IgnoreTree(), dir, ["anything"], false), /could not read .*\.agentevalsignore/);
});
