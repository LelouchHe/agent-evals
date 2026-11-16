import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { matchesIgnorePattern, readIgnorePatterns } from "./ignore.ts";

test("comments, blank lines and surrounding whitespace are not patterns", async (t) => {
  const dir = await makeTempDir(t, "ae-ignore-");
  await writeFile(join(dir, ".agentevalsignore"), "# eval assets\n\n  evals  \n\n#tests\n");

  assert.deepEqual(await readIgnorePatterns(dir), [["evals"]]);
});

test("a pattern segment is literal or *, so a partial glob is a configuration error", async (t) => {
  const dir = await makeTempDir(t, "ae-ignore-");
  for (const line of ["*.pyc", "build/*.log", "evals/__pycache__/*.pyc"]) {
    await writeFile(join(dir, ".agentevalsignore"), `${line}\n`);
    await assert.rejects(
      readIgnorePatterns(dir),
      (error: Error) =>
        error.message.includes(`.agentevalsignore:1: pattern "${line}"`) && /inside a segment/.test(error.message),
      line,
    );
  }
});

test("an absolute, escaping, empty or ** pattern is rejected rather than treated as a literal", async (t) => {
  const dir = await makeTempDir(t, "ae-ignore-");
  for (const [line, reason] of [
    ["/evals", /relative to the directory/],
    ["evals/../../etc", /must not contain "\.\."/],
    ["evals//tmp", /empty segment/],
    ["evals\\tmp", /separate segments with \//],
    ["evals/**/tmp", /"\*" matches exactly one segment/],
    ["/", /empty segment/],
  ] as const) {
    await writeFile(join(dir, ".agentevalsignore"), `${line}\n`);
    await assert.rejects(readIgnorePatterns(dir), (error: Error) => error.message.includes(`pattern "${line}"`), line);
    await assert.rejects(readIgnorePatterns(dir), reason, line);
  }
});

test("a trailing slash names the directory and * matches exactly one segment", async (t) => {
  const dir = await makeTempDir(t, "ae-ignore-");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".agentevalsignore"), "evals/\nreferences/*/draft.md\n");

  const patterns = await readIgnorePatterns(dir);
  assert.deepEqual(patterns, [["evals"], ["references", "*", "draft.md"]]);
  assert.equal(matchesIgnorePattern(patterns, ["evals"]), true);
  assert.equal(matchesIgnorePattern(patterns, ["references", "private", "draft.md"]), true);
  // `*` is one whole segment: it neither spans segments nor matches a prefix.
  assert.equal(matchesIgnorePattern(patterns, ["references", "private", "tmp", "draft.md"]), false);
  assert.equal(matchesIgnorePattern(patterns, ["evals", "SKILL.md"]), false);
  assert.equal(matchesIgnorePattern(patterns, ["eval"]), false);
});
