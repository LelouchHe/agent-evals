import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { fileChecker } from "../src/checkers/file/index.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { ConfigError } from "../src/engine/config.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { acpRunner } from "../src/runners/acp/index.ts";
import { noopRunner } from "../src/runners/noop/index.ts";
import { makeAcpAgent } from "./helpers/acp-agent.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

type Declaration = Record<string, unknown>;

function registry() {
  const value = createRegistry();
  addRunner(value, acpRunner, "built-in");
  addRunner(value, noopRunner, "built-in");
  addChecker(value, fileChecker, "built-in");
  return value;
}

async function runCase(casePath: string, root: string, name: string) {
  const runs = join(root, "runs");
  await mkdir(runs, { recursive: true });
  return runEvaluation({
    case: await loadCase(casePath),
    registry: registry(),
    resultsDir: join(root, `results-${name}`),
    tempParent: runs,
  });
}

/** One authoring directory with a `today.md` source file, relative to `root`. */
async function source(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "today.md"), content);
  return name;
}

/** Run one ACP case whose `files` and `checks` the test builds from the fixture root. */
async function runHomeCase(t: TestContext, build: (root: string) => Promise<Declaration> | Declaration) {
  const fixture = await makeAcpAgent(t, "success");
  await mkdir(join(fixture.login, ".auth"), { recursive: true });
  // A declared login file the fake agent rewrites with the HOME it saw.
  await writeFile(join(fixture.login, ".auth/home"), "");
  const casePath = join(fixture.root, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "write the answer",
      checks: [{ $type: "file", path: "answer.txt", matches: "model-a" }],
      ...(await build(fixture.root)),
      runner: { $type: "acp", agent: "agent.yml" },
    }),
  );
  const record = await runCase(casePath, fixture.root, "home");
  return { fixture, record, casePath };
}

async function runNoopCase(t: TestContext, build: (root: string) => Promise<Declaration> | Declaration) {
  const root = await makeTempDir(t, "ae-home-noop-");
  const casePath = join(root, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "task",
      runner: { $type: "noop" },
      checks: [{ $type: "file", path: "x", exists: false }],
      ...(await build(root)),
    }),
  );
  return { casePath, root };
}

test("a case places files in HOME, replaces an agent-placed file and checks both", async (t) => {
  const { fixture, record } = await runHomeCase(t, async (root) => {
    const notes = await source(root, "notes", "moved\n");
    const settings = await source(root, "settings", '{"model":"case"}\n');
    return {
      files: {
        "~/notes/today.md": `${notes}/today.md`,
        "~/settings.json": `${settings}/today.md`,
      },
      checks: [
        { $type: "file", path: "~/notes/today.md", matches: "moved" },
        { $type: "file", path: "~/settings.json", matches: '"case"' },
        // Both are case placements, so the HOME baseline carries them.
        { $type: "file", path: "~/notes/today.md", changed: false },
        { $type: "file", path: "~/settings.json", changed: false },
      ],
    };
  });
  assert.equal(record.status, "pass", record.error);
  const home = JSON.parse(await readFile(join(fixture.login, ".auth/home"), "utf8")) as {
    settings: string;
    entries: string[];
  };
  assert.equal(home.settings, '{"model":"case"}\n');
  assert.ok(home.entries.includes("notes"));
});

test("a case files entry may place a whole HOME tree, and honours .agentevalsignore", async (t) => {
  const { record } = await runHomeCase(t, async (root) => {
    const notes = await source(root, "notes", "kept\n");
    await writeFile(join(root, notes, "excluded.md"), "excluded\n");
    await writeFile(join(root, notes, ".agentevalsignore"), "excluded.md\n");
    return {
      files: { "~/": notes },
      checks: [
        { $type: "file", path: "~/today.md", exists: true },
        { $type: "file", path: "~/excluded.md", exists: false },
      ],
    };
  });
  assert.equal(record.status, "pass", record.error);
});

test("a case may not replace login state, and an agent file may not collide with it", async (t) => {
  const fixture = await makeAcpAgent(t, "success");
  await mkdir(join(fixture.login, ".auth"), { recursive: true });
  await writeFile(join(fixture.login, ".auth/token"), "original-token");
  const forged = await source(fixture.root, "token", "replacement\n");
  const casePath = join(fixture.root, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "task",
      files: { "~/.auth/token": `${forged}/today.md` },
      checks: [{ $type: "file", path: "x", exists: false }],
      runner: { $type: "acp", agent: "agent.yml" },
    }),
  );
  await assert.rejects(() => runCase(casePath, fixture.root, "login"), /collides with login state at \.auth\/token/);

  // The agent file's own files may not collide with its declared login files either.
  const agentPath = join(fixture.root, "collide.yml");
  await writeFile(agentPath, stringify({ ...fixture.config, files: { "~/.auth/token": `${forged}/today.md` } }));
  await writeFile(
    casePath,
    stringify({
      input: "task",
      checks: [{ $type: "file", path: "x", exists: false }],
      runner: { $type: "acp", agent: "collide.yml" },
    }),
  );
  await assert.rejects(
    () => runCase(casePath, fixture.root, "agent-login"),
    (error: unknown) => error instanceof ConfigError && /collides with login file/.test(error.message),
  );
  assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "original-token");
});

test("two case entries and a file-versus-directory conflict fail before the harness runs", async (t) => {
  const cases: readonly [(root: string) => Declaration | Promise<Declaration>, RegExp][] = [
    [
      async (root) => {
        await source(root, "one", "one\n");
        return { files: { "~/dup.md": "one/today.md", "~/./dup.md": "one/today.md" } };
      },
      /entry "~\/\.\/dup\.md" overwrites ~\/\.\/dup\.md, which another files entry provides/,
    ],
    [
      async (root) => {
        // The directory entry stages `today.md` as a directory; a file entry cannot replace it.
        const dir = join(root, "dir");
        await mkdir(join(dir, "today.md"), { recursive: true });
        await writeFile(join(dir, "today.md", "inside.md"), "inside\n");
        const file = await source(root, "file", "file\n");
        return { files: { "~/tree": "dir", "~/tree/today.md": `${file}/today.md` } };
      },
      /places a file at ~\/tree\/today\.md, where a directory already exists/,
    ],
  ];
  for (const [build, message] of cases) {
    const { record } = await runHomeCase(t, build);
    assert.equal(record.status, "error");
    assert.match(record.error ?? "", message);
  }
});

test("a runner without a HOME rejects case files and file checks under ~/", async (t) => {
  const declarations: readonly [(root: string) => Declaration | Promise<Declaration>, RegExp][] = [
    [
      async (root) => {
        await source(root, "value", "content\n");
        return { files: { "~/value.md": "value/today.md" } };
      },
      /does not support case files under "~"/,
    ],
    [() => ({ checks: [{ $type: "file", path: "~/value.md", exists: true }] }), /does not provide/],
  ];
  for (const [build, message] of declarations) {
    const { casePath, root } = await runNoopCase(t, build);
    await assert.rejects(() => runCase(casePath, root, "noop"), message);
  }
});
