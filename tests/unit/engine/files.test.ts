import assert from "node:assert/strict";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../helpers/fake-pi-control.ts";
import { stageFiles } from "../../../src/engine/files.ts";

/** Every file below `dir`, as sorted relative paths. */
async function filesIn(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    files.push(...(entry.isDirectory() ? await filesIn(join(dir, entry.name), path) : [path]));
  }
  return files.sort();
}

async function write(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}

async function stage(t: Parameters<typeof makeTempDir>[0]) {
  const root = await makeTempDir(t, "ae-stage-");
  const authoring = join(root, "authoring");
  const staging = join(root, "staging");
  await mkdir(authoring);
  await mkdir(staging);
  return {
    authoring,
    staging,
    stage: (files: Readonly<Record<string, string>>) => stageFiles(files, authoring, staging, "files"),
    files: () => filesIn(staging),
  };
}

test("a copied directory places its runtime files and keeps its declared non-runtime content out", async (t) => {
  const dirs = await stage(t);
  await write(dirs.authoring, {
    "skill/.agentevalsignore": "# eval assets\n\n/evals\n",
    "skill/SKILL.md": "body\n",
    "skill/references/rules.md": "rules\n",
    "skill/evals/agent-evals/routing.yml": "input: leaked\n",
    "skill/evals/behavior.json": "{}\n",
  });

  await dirs.stage({ "skills/markdown-writing": "skill" });

  // The ignore file itself is never placed either: it is authoring metadata, not runtime content.
  assert.deepEqual(await dirs.files(), [
    "skills/markdown-writing/SKILL.md",
    "skills/markdown-writing/references/rules.md",
  ]);
});

test("each directory's patterns apply from that directory, so one roster excludes per skill", async (t) => {
  const dirs = await stage(t);
  await write(dirs.authoring, {
    "skills/markdown-writing/.agentevalsignore": "/evals\n",
    "skills/markdown-writing/SKILL.md": "body\n",
    "skills/markdown-writing/evals/agent-evals/routing.yml": "input: leaked\n",
    "skills/skill-eval/.agentevalsignore": "/tests\n",
    "skills/skill-eval/SKILL.md": "body\n",
    "skills/skill-eval/tests/run.py": "assert True\n",
    "skills/task-delegation/SKILL.md": "body\n",
  });

  await dirs.stage({ ".": "skills" });

  assert.deepEqual(await dirs.files(), [
    "markdown-writing/SKILL.md",
    "skill-eval/SKILL.md",
    "task-delegation/SKILL.md",
  ]);
});

test("a source named directly is placed even when its parent's ignore file excludes it", async (t) => {
  const dirs = await stage(t);
  await write(dirs.authoring, {
    ".agentevalsignore": "evals\n",
    "evals/case.yml": "input: copied on purpose\n",
  });

  // Placements name a source, and only directories the copy then traverses consult an ignore file.
  await dirs.stage({ cases: "evals" });

  assert.deepEqual(await dirs.files(), ["cases/case.yml"]);
});

test("a deeper ignore file cannot re-include what a higher one excluded", async (t) => {
  const dirs = await stage(t);
  await write(dirs.authoring, {
    "skill/.agentevalsignore": "/evals/agent-evals\n",
    "skill/SKILL.md": "body\n",
    "skill/evals/.agentevalsignore": "!agent-evals\n",
    "skill/evals/agent-evals/routing.yml": "input: leaked\n",
    "skill/evals/behavior.json": "{}\n",
  });

  await dirs.stage({ "skills/markdown-writing": "skill" });

  // The exclusion is combined across files, so `!` only re-includes within the file that used it.
  assert.deepEqual(await dirs.files(), [
    "skills/markdown-writing/SKILL.md",
    "skills/markdown-writing/evals/behavior.json",
  ]);
});

test("a directory-only pattern excludes the directory, and leaves a file of that name", async (t) => {
  const dirs = await stage(t);
  await write(dirs.authoring, {
    "skill/.agentevalsignore": "/evals/\n",
    "skill/SKILL.md": "body\n",
    "skill/evals/leaked.txt": "leaked\n",
    "plain/.agentevalsignore": "evals/\n",
    "plain/evals": "a regular file called evals\n",
    "plain/nested/evals/leaked.txt": "leaked\n",
  });

  await dirs.stage({ "skills/x": "skill", "skills/y": "plain" });

  assert.deepEqual(await dirs.files(), ["skills/x/SKILL.md", "skills/y/evals"]);
  // Excluding the contents is not enough: the directory itself must not reach the workspace.
  for (const absent of ["skills/x/evals", "skills/y/nested/evals"]) {
    await assert.rejects(access(join(dirs.staging, absent)), absent);
  }
});
