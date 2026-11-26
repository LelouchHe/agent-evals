import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import type { EvaluationRecord } from "../src/engine/results.ts";
import { runCliProcess } from "./helpers/cli-process.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

async function writeRetentionFixture(t: TestContext): Promise<{
  readonly directory: string;
  readonly runs: string;
  readonly resultsDir: string;
  readonly extensionDir: string;
  readonly hostSecret: string;
}> {
  const directory = await makeTempDir(t, "ae-retain-");
  const runs = join(directory, "runs");
  const resultsDir = join(directory, "results");
  const extensionDir = join(directory, "extensions");
  const hostSecret = join(directory, "host-secret.txt");
  await mkdir(runs);
  await mkdir(join(extensionDir, "writer"), { recursive: true });
  await writeFile(hostSecret, "never-copy-me\n");

  // Extension runner that declares login files in HOME, writes into workspace and HOME,
  // creates a hardlink alias to a login file, and plants a symlink to a host file.
  await writeFile(
    join(extensionDir, "writer", "index.mjs"),
    `
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const runner = {
  type: "writer",
  home: true,
  params: {
    async safeParseAsync(raw) {
      return {
        success: true,
        data: { hostSecret: typeof raw.hostSecret === "string" ? raw.hostSecret : "" },
      };
    },
  },
  create(parsed) {
    return {
      homeFiles: [".secret/token.json"],
      async prepareHome(context) {
        await mkdir(join(context.homeDir, ".secret"), { recursive: true });
        await writeFile(join(context.homeDir, ".secret", "token.json"), "super-secret-token\\n");
        return [".secret/token.json"];
      },
      async run(context) {
        await writeFile(join(context.workspaceDir, "output.txt"), "workspace-artifact\\n");
        await mkdir(join(context.homeDir, "mine", "space", "Plan", "New"), { recursive: true });
        await writeFile(join(context.homeDir, "mine", "space", "Plan", "New", "handover.md"), "saved-in-home\\n");
        // Hardlink aliases to the protected login file (in both HOME and workspace) and a symlink
        // to a host file must all be excluded.
        await link(join(context.homeDir, ".secret", "token.json"), join(context.homeDir, "token-alias.json"));
        await link(join(context.homeDir, ".secret", "token.json"), join(context.workspaceDir, "workspace-token-alias.json"));
        // A workspace file named result.json must not confuse agent-evals report.
        await writeFile(join(context.workspaceDir, "result.json"), "not-a-record\\n");
        if (parsed.hostSecret.length > 0) {
          await symlink(parsed.hostSecret, join(context.workspaceDir, "escape-link.txt"));
        }
        return { finalText: "done", diagnostics: [] };
      },
      async stop() {},
    };
  },
};
`,
  );

  return { directory, runs, resultsDir, extensionDir, hostSecret };
}

async function readRunRecords(resultsDir: string): Promise<Map<string, EvaluationRecord>> {
  const byCase = new Map<string, EvaluationRecord>();
  for (const runId of await readdir(resultsDir)) {
    const record: EvaluationRecord = JSON.parse(await readFile(join(resultsDir, runId, "result.json"), "utf8"));
    byCase.set(record.case.name ?? "single", record);
  }
  return byCase;
}

test("--retain on-failure retains only unexpected failures and passes, skipping pass and expected-fail", async (t) => {
  const { directory, runs, resultsDir } = await writeRetentionFixture(t);
  const path = join(directory, "case.yml");
  await writeFile(
    path,
    stringify({
      input: "task",
      cases: {
        passing: {
          runner: { $type: "noop" },
          checks: [{ $type: "file", path: "missing.txt", exists: false }],
        },
        failing: {
          runner: { $type: "noop" },
          checks: [{ $type: "file", path: "missing.txt", exists: true }],
        },
        "expected-failure": {
          runner: { $type: "noop" },
          expect: "fail",
          checks: [{ $type: "file", path: "missing.txt", exists: true }],
        },
        "unexpected-pass": {
          runner: { $type: "noop" },
          expect: "fail",
          checks: [{ $type: "file", path: "missing.txt", exists: false }],
        },
      },
    }),
  );

  const run = await runCliProcess(t, CLI, ["run", path, "--retain", "on-failure", "--results-dir", resultsDir], {
    cwd: directory,
    env: { ...process.env, TMPDIR: runs },
  });
  assert.equal(run.code, 1, run.stderr);

  const records = await readRunRecords(resultsDir);
  assert.equal(records.get("passing")?.artifacts, undefined);
  assert.equal(records.get("expected-failure")?.artifacts, undefined);
  assert.equal(records.get("failing")?.artifacts?.status, "retained");
  assert.equal(records.get("unexpected-pass")?.artifacts?.status, "retained");

  // Temporary run roots are still removed even when artifacts are retained.
  assert.deepEqual(await readdir(runs), []);
});

test("--retain all copies workspace and home while excluding login files, hardlink aliases, and symlinks", async (t) => {
  const { directory, runs, resultsDir, extensionDir, hostSecret } = await writeRetentionFixture(t);
  const vault = join(directory, "vault");
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, "existing.md"), "initial-vault\n");

  const path = join(directory, "case.yml");
  await writeFile(
    path,
    stringify({
      input: "task",
      runner: { $type: "writer", hostSecret },
      files: { "~/mine/space": "vault" },
      checks: [{ $type: "file", path: "output.txt", matches: "workspace-artifact" }],
    }),
  );

  const run = await runCliProcess(
    t,
    CLI,
    ["run", path, "--retain", "all", "--extension-dir", extensionDir, "--results-dir", resultsDir],
    { cwd: directory, env: { ...process.env, TMPDIR: runs } },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^ {2}artifacts: /m);

  const [runId] = await readdir(resultsDir);
  assert.ok(runId !== undefined);
  const artifactsDir = join(resultsDir, runId, "artifacts");

  assert.equal(await readFile(join(artifactsDir, "workspace", "output.txt"), "utf8"), "workspace-artifact\n");
  assert.equal(await readFile(join(artifactsDir, "home", "mine", "space", "existing.md"), "utf8"), "initial-vault\n");
  assert.equal(
    await readFile(join(artifactsDir, "home", "mine", "space", "Plan", "New", "handover.md"), "utf8"),
    "saved-in-home\n",
  );

  // Protected login files, hardlink aliases (in HOME or workspace), and symlinks must not be copied.
  await assert.rejects(readFile(join(artifactsDir, "home", ".secret", "token.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(artifactsDir, "home", "token-alias.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(artifactsDir, "workspace", "workspace-token-alias.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(artifactsDir, "workspace", "escape-link.txt")), { code: "ENOENT" });

  // `report` must ignore workspace files named `result.json` inside `artifacts/`, even in an
  // incomplete run directory that has no top-level `result.json`.
  assert.equal(await readFile(join(artifactsDir, "workspace", "result.json"), "utf8"), "not-a-record\n");
  await mkdir(join(resultsDir, "incomplete-run", "artifacts", "workspace"), { recursive: true });
  await writeFile(join(resultsDir, "incomplete-run", "artifacts", "workspace", "result.json"), "not-json\n");
  const reportRun = await runCliProcess(t, CLI, ["report", resultsDir], { cwd: directory });
  assert.equal(reportRun.code, 0, reportRun.stderr);

  // Sandbox run root is still removed.
  assert.deepEqual(await readdir(runs), []);
});

test("--retain rejects unknown modes and non-run commands", async (t) => {
  const directory = await makeTempDir(t, "ae-retain-invalid-");
  const path = join(directory, "case.yml");
  await writeFile(path, stringify({ input: "task", runner: { $type: "noop" }, checks: [] }));

  const badMode = await runCliProcess(t, CLI, ["run", path, "--retain", "always"], { cwd: directory });
  assert.equal(badMode.code, 2);
  assert.match(badMode.stderr, /--retain must be "none", "on-failure", or "all"/);

  const onView = await runCliProcess(t, CLI, ["view", path, "--retain", "all"], { cwd: directory });
  assert.equal(onView.code, 2);
  assert.match(onView.stderr, /view does not accept .*--retain/);
});
