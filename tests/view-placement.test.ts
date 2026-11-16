import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { runCliProcess } from "./helpers/cli-process.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

async function writeCase(t: Parameters<typeof makeTempDir>[0]): Promise<{ root: string; casePath: string }> {
  const root = await makeTempDir(t, "ae-view-placement-");
  await mkdir(join(root, "fixture/b"), { recursive: true });
  await mkdir(join(root, "fixture/dirskip"), { recursive: true });
  await writeFile(join(root, "fixture/a.txt"), "a\n");
  await writeFile(join(root, "fixture/b/c.txt"), "c\n");
  await writeFile(join(root, "fixture/dirskip/x.txt"), "x\n");
  await writeFile(join(root, "fixture/skip.log"), "skip\n");
  await writeFile(join(root, "fixture/.agentevalsignore"), "skip.log\ndirskip/\n");

  await mkdir(join(root, "skills/aw-x/references"), { recursive: true });
  await mkdir(join(root, "skills/aw-x/evals"), { recursive: true });
  await writeFile(join(root, "skills/aw-x/SKILL.md"), "---\nname: aw-x\n---\n");
  await writeFile(join(root, "skills/aw-x/references/r.md"), "ref\n");
  await writeFile(join(root, "skills/aw-x/evals/routing.json"), "{}\n");
  await writeFile(join(root, "skills/aw-x/.agentevalsignore"), "evals\n");

  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes/today.md"), "today\n");

  const casePath = join(root, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "task",
      fixture: "fixture",
      files: { ".agents/skills": "skills", "~/notes": "notes" },
      runner: { $type: "noop" },
      checks: [{ $type: "file", path: "a.txt", exists: true }],
    }),
  );
  return { root, casePath };
}

async function view(
  t: Parameters<typeof makeTempDir>[0],
  casePath: string,
  root: string,
  extra: readonly string[] = [],
) {
  return runCliProcess(t, CLI, ["view", casePath, ...extra], { cwd: root });
}

test("view counts what the case would place, without starting a runtime", async (t) => {
  const { root, casePath } = await writeCase(t);
  const result = await view(t, casePath, root);
  assert.equal(result.code, 0, result.stderr);
  const placement = result.stdout.slice(result.stdout.indexOf("placement:"));
  assert.equal(
    placement,
    [
      "placement:",
      "  fixture fixture: 2 placed, 2 excluded",
      '  files ".agents/skills": 2 placed, 1 excluded',
      '  home "~/notes": 1 placed, 0 excluded',
      "",
    ].join("\n"),
  );
});

test("view --files names every placed path, every exclusion and its deciding ignore file", async (t) => {
  const { root, casePath } = await writeCase(t);
  const result = await view(t, casePath, root, ["--files"]);
  assert.equal(result.code, 0, result.stderr);
  const placement = result.stdout.slice(result.stdout.indexOf("placement:"));
  assert.equal(
    placement,
    [
      "placement:",
      "  fixture fixture: 2 placed, 2 excluded",
      "    place   a.txt <- fixture/a.txt",
      "    place   b/c.txt <- fixture/b/c.txt",
      "    exclude dirskip (directory) <- .agentevalsignore at fixture",
      "    exclude skip.log <- .agentevalsignore at fixture",
      '  files ".agents/skills": 2 placed, 1 excluded',
      "    place   .agents/skills/aw-x/SKILL.md <- skills/aw-x/SKILL.md",
      "    place   .agents/skills/aw-x/references/r.md <- skills/aw-x/references/r.md",
      "    exclude .agents/skills/aw-x/evals (directory) <- .agentevalsignore at skills/aw-x",
      '  home "~/notes": 1 placed, 0 excluded',
      "    place   ~/notes/today.md <- notes/today.md",
      "",
    ].join("\n"),
  );
});

test("--files is a view option, not a run option", async (t) => {
  const { root, casePath } = await writeCase(t);
  const result = await runCliProcess(t, CLI, ["run", casePath, "--files"], { cwd: root });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--files applies only to view/);
});
