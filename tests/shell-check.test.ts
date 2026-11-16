import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { z } from "zod";
import { fileChecker } from "../src/checkers/file/index.ts";
import { mockChecker } from "../src/checkers/mock/index.ts";
import { shellChecker } from "../src/checkers/shell/index.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { ConfigError } from "../src/engine/config.ts";
import {
  addChecker,
  addRunner,
  createRegistry,
  type CheckerDefinition,
  type Registry,
  type RunnerDefinition,
} from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { noopRunner } from "../src/runners/noop/index.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const PASSING_TEST = `const assert = require("node:assert/strict");
const { test } = require("node:test");
test("acceptance", () => assert.equal(2 + 2, 4));
`;

/** A test-only runner that plants symlinks in the workspace, modeling an agent's leftovers. */
const plantingRunner: RunnerDefinition<{ readonly links: Readonly<Record<string, string>> }> = {
  type: "planting",
  params: z.strictObject({ links: z.record(z.string(), z.string()).default({}) }),
  create: (params) => ({
    run: async (context) => {
      for (const [destination, target] of Object.entries(params.links)) {
        const path = join(context.workspaceDir, destination);
        await mkdir(dirname(path), { recursive: true });
        await symlink(target, path);
      }
      return { finalText: null, diagnostics: [] };
    },
    stop: async () => {},
    trace: () => [],
  }),
};

interface RunOptions {
  readonly caseSubdir?: string;
  /** Files written under the temporary root, keyed by a root-relative path. */
  readonly assets?: Readonly<Record<string, string>>;
  readonly register?: (registry: Registry) => void;
}

async function runCase(
  t: Parameters<typeof makeTempDir>[0],
  declaration: Record<string, unknown> | ((directory: string) => Record<string, unknown>),
  options: RunOptions = {},
) {
  const directory = await makeTempDir(t, "ae-shell-check-case-");
  for (const [name, content] of Object.entries(options.assets ?? {})) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const caseDir = join(directory, options.caseSubdir ?? ".");
  await mkdir(caseDir, { recursive: true });
  const built = typeof declaration === "function" ? declaration(directory) : declaration;
  const casePath = join(caseDir, "case.yml");
  await writeFile(casePath, stringify({ input: "task", runner: { $type: "noop" }, ...built }));
  const registry = createRegistry();
  addRunner(registry, noopRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, mockChecker, "built-in");
  addChecker(registry, shellChecker, "built-in");
  options.register?.(registry);
  const resultsDir = await makeTempDir(t, "ae-shell-check-results-");
  const tempParent = await makeTempDir(t, "ae-shell-check-runs-");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent,
  });
  return { directory, record, resultsDir, tempParent };
}

test(
  "a shell check runs in the live workspace and passes on exit 0",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const { record } = await runCase(t, {
      checks: [
        { $type: "shell", run: ["/bin/sh", "-c", "printf made > artifact.txt"] },
        { $type: "file", path: "artifact.txt", matches: "/^made$/" },
      ],
    });
    assert.equal(record.status, "pass", record.error);
    assert.deepEqual(
      record.checks.map((check) => [check.subject, check.status]),
      [
        ["run /bin/sh -c printf made > artifact.txt", "pass"],
        ["artifact.txt matches /^made$/", "pass"],
      ],
    );
  },
);

test(
  "a shell check fails on a nonzero exit and keeps the output tail as its reason",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const { record } = await runCase(t, {
      checks: [
        {
          $type: "shell",
          run: ["/bin/sh", "-c", "printf 'first line\\nassertion failed\\n' >&2; exit 3"],
        },
      ],
    });
    assert.equal(record.status, "fail");
    assert.equal(record.checks[0]?.status, "fail");
    assert.match(record.checks[0]?.reason ?? "", /exit status 3: first line\nassertion failed/);
  },
);

test(
  "a shell check that cannot start or overruns is an error, not a failed judgment",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const missing = await runCase(t, { checks: [{ $type: "shell", run: ["agent-evals-definitely-missing"] }] });
    assert.equal(missing.record.status, "error");
    assert.match(missing.record.checks[0]?.reason ?? "", /could not start agent-evals-definitely-missing/);

    const slow = await runCase(t, {
      timeoutMs: 1_000,
      checks: [{ $type: "shell", run: ["/bin/sh", "-c", "sleep 30"] }],
    });
    assert.equal(slow.record.status, "error");
    assert.match(slow.record.checks[0]?.reason ?? "", /did not finish before the check deadline/);
  },
);

test(
  "mocked PATH commands and the closed mock host are gone at check time",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const { record } = await runCase(t, {
      mocks: {
        shell: {
          "agent-evals-check-tool": { return: { stdout: "answered\n" } },
          "./scripts/inspect.sh": { return: { stdout: "inspected\n" } },
        },
      },
      checks: [
        // The check sandbox gets the operator's PATH, not the runner's forwarder directory.
        { $type: "shell", run: ["/bin/sh", "-c", "command -v agent-evals-check-tool"] },
        // The workspace forwarder is still at its path, but its host has closed.
        { $type: "shell", run: ["./scripts/inspect.sh"] },
        // Restraint holds because nothing ran.
        { $type: "mock", shell: ["agent-evals-check-tool"], times: 0 },
      ],
    });
    assert.equal(record.status, "fail");
    assert.deepEqual(
      record.checks.map((check) => check.status),
      ["fail", "fail", "pass"],
    );
    assert.match(record.checks[1]?.reason ?? "", /Service unavailable/);
  },
);

test(
  "a shell check that writes outside the workspace fails at the sandbox boundary",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const { record } = await runCase(t, (directory) => ({
      checks: [
        { $type: "shell", run: ["/bin/sh", "-c", 'printf outside > "$1"', "sh", join(directory, "escape.txt")] },
      ],
    }));
    assert.equal(record.status, "fail");
    assert.match(record.checks[0]?.reason ?? "", /Operation not permitted/);
  },
);

test(
  "cancelling the run during a shell check is reported as cancellation, not a deadline",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const directory = await makeTempDir(t, "ae-shell-cancel-case-");
    const casePath = join(directory, "case.yml");
    await writeFile(
      casePath,
      stringify({
        input: "task",
        timeoutMs: 60_000,
        runner: { $type: "noop" },
        checks: [{ $type: "shell", run: ["/bin/sh", "-c", "printf started > started.txt; /bin/sleep 30"] }],
      }),
    );
    const registry = createRegistry();
    addRunner(registry, noopRunner, "built-in");
    addChecker(registry, shellChecker, "built-in");
    const resultsDir = await makeTempDir(t, "ae-shell-cancel-results-");
    const tempParent = await makeTempDir(t, "ae-shell-cancel-runs-");
    const controller = new AbortController();
    const running = runEvaluation({
      case: await loadCase(casePath),
      registry,
      resultsDir,
      tempParent,
      signal: controller.signal,
    });

    // Wait until the check program is running before cancelling.
    let started = false;
    for (let attempt = 0; attempt < 500 && !started; attempt += 1) {
      for (const run of await readdir(tempParent)) {
        const files = await readdir(join(tempParent, run, "workspace")).catch((): string[] => []);
        if (files.includes("started.txt")) {
          started = true;
          break;
        }
      }
      if (!started) await delay(20, undefined, { signal: t.signal });
    }
    assert.equal(started, true, "the shell check never started");
    controller.abort();

    const record = await running;
    assert.equal(record.status, "cancelled", record.error);
    assert.equal(record.checks[0]?.status, "error");
    assert.match(record.checks[0]?.reason ?? "", /run was cancelled while this check was running/);
    assert.doesNotMatch(record.checks[0]?.reason ?? "", /deadline/);
    assert.deepEqual(await readdir(tempParent), []);
  },
);

test(
  "check-time files stay hidden until the shell check runs and reach later checks",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const { record, tempParent } = await runCase(
      t,
      {
        checks: [
          // Before the shell check runs, the acceptance test does not exist.
          { $type: "file", path: "tests/acceptance.test.js", exists: false },
          {
            $type: "shell",
            files: { "tests/acceptance.test.js": "../shared/acceptance.test.js" },
            run: ["node", "--test", "tests/acceptance.test.js"],
          },
          // The placed file stays in the live workspace for the next check.
          { $type: "file", path: "tests/acceptance.test.js", matches: '/require\\("node:test"\\)/' },
        ],
      },
      { caseSubdir: "cases", assets: { "shared/acceptance.test.js": PASSING_TEST } },
    );
    assert.equal(record.status, "pass", record.error);
    assert.deepEqual(
      record.checks.map((check) => check.status),
      ["pass", "pass", "pass"],
    );
    // The check-time file and everything else live under the run root removed at teardown.
    assert.deepEqual(await readdir(tempParent), []);
  },
);

test(
  "check-time files replace a fixture's failing test before it runs",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const failing = `const assert = require("node:assert/strict");
const { test } = require("node:test");
test("agent's failing test", () => assert.fail("the agent wrote this"));
`;
    const { record } = await runCase(
      t,
      {
        fixture: "fixture",
        checks: [
          {
            $type: "shell",
            files: { "tests/acceptance.test.js": "checks/acceptance.test.js" },
            run: ["node", "--test", "tests/acceptance.test.js"],
          },
          { $type: "file", path: "tests/acceptance.test.js", matches: "acceptance" },
        ],
      },
      {
        assets: {
          "fixture/tests/acceptance.test.js": failing,
          "checks/acceptance.test.js": PASSING_TEST,
        },
      },
    );
    assert.equal(record.status, "pass", record.error);
  },
);

test("a missing check-time file source is a configuration error before any run directory", async (t) => {
  const directory = await makeTempDir(t, "ae-shell-files-load-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "task",
      runner: { $type: "noop" },
      checks: [
        {
          $type: "shell",
          files: { "tests/acceptance.test.js": "checks/missing.test.js" },
          run: ["node", "tests/acceptance.test.js"],
        },
      ],
    }),
  );
  const registry = createRegistry();
  addRunner(registry, noopRunner, "built-in");
  addChecker(registry, shellChecker, "built-in");
  const resultsDir = await makeTempDir(t, "ae-shell-files-load-results-");
  const tempParent = await makeTempDir(t, "ae-shell-files-load-runs-");
  await assert.rejects(
    async () => runEvaluation({ case: await loadCase(casePath), registry, resultsDir, tempParent }),
    (error: unknown) => error instanceof ConfigError && /check files.*is not accessible/.test(error.message),
  );
  assert.deepEqual(await readdir(tempParent), []);
  assert.deepEqual(await readdir(resultsDir), []);
});

test(
  "a symlink the agent left at a destination is replaced, not followed",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const outside = await makeTempDir(t, "ae-shell-files-outside-");
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "do not touch\n");
    const { record } = await runCase(
      t,
      {
        runner: { $type: "planting", links: { "tests/acceptance.test.js": sentinel } },
        checks: [
          {
            $type: "shell",
            files: { "tests/acceptance.test.js": "checks/acceptance.test.js" },
            run: ["node", "--test", "tests/acceptance.test.js"],
          },
        ],
      },
      {
        assets: { "checks/acceptance.test.js": PASSING_TEST },
        register: (registry) => addRunner(registry, plantingRunner, "test"),
      },
    );
    assert.equal(record.status, "pass", record.error);
    assert.equal(await readFile(sentinel, "utf8"), "do not touch\n");
  },
);

test(
  "an ancestor symlink the agent left is refused and the outside stays untouched",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const outside = await makeTempDir(t, "ae-shell-files-outside-");
    const { record } = await runCase(
      t,
      {
        runner: { $type: "planting", links: { tests: outside } },
        checks: [
          {
            $type: "shell",
            files: { "tests/acceptance.test.js": "checks/acceptance.test.js" },
            run: ["node", "--test", "tests/acceptance.test.js"],
          },
        ],
      },
      {
        assets: { "checks/acceptance.test.js": PASSING_TEST },
        register: (registry) => addRunner(registry, plantingRunner, "test"),
      },
    );
    assert.equal(record.status, "error");
    assert.equal(record.checks[0]?.status, "error");
    assert.match(record.checks[0]?.reason ?? "", /symlink/);
    assert.deepEqual(await readdir(outside), []);
  },
);

test(
  "a custom checker gets engine files validation and sandbox staging",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const customChecker: CheckerDefinition<{ readonly files: Record<string, string>; readonly run: string[] }> = {
      type: "custom-shell",
      params: z.strictObject({
        files: z.record(z.string(), z.string()),
        run: z.array(z.string()).min(1),
      }),
      async create(params, context) {
        await context.validateFiles(params.files);
        return {
          check: async (checkContext) => {
            const outcome = await checkContext.checkSandbox.run(params.run, { files: params.files });
            const pass = outcome.kind === "exited" && outcome.exitCode === 0;
            return [
              { checker: "custom-shell", subject: "custom", status: pass ? "pass" : "fail", reason: outcome.kind },
            ];
          },
        };
      },
    };
    const options = {
      assets: { "checks/acceptance.txt": "custom body\n" },
      register: (registry: Registry) => addChecker(registry, customChecker, "test"),
    };

    const { record } = await runCase(
      t,
      {
        checks: [
          {
            $type: "custom-shell",
            files: { "tests/acceptance.txt": "checks/acceptance.txt" },
            run: ["/bin/sh", "-c", 'test "$(cat tests/acceptance.txt)" = "custom body"'],
          },
        ],
      },
      options,
    );
    assert.equal(record.status, "pass", record.error);

    // The same public validateFiles rejects an unsafe destination without any checker schema.
    await assert.rejects(
      () =>
        runCase(
          t,
          {
            checks: [{ $type: "custom-shell", files: { "../escape": "checks/acceptance.txt" }, run: ["/bin/true"] }],
          },
          options,
        ),
      (error: unknown) => error instanceof ConfigError && /must not contain "\.\."/.test(error.message),
    );
  },
);
