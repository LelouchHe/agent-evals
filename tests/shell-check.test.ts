import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { fileChecker } from "../src/checkers/file/checker.ts";
import { mockChecker } from "../src/checkers/mock/checker.ts";
import { shellChecker } from "../src/checkers/shell/checker.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { noopRunner } from "../src/runners/noop/runner.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

async function runCase(
  t: Parameters<typeof makeTempDir>[0],
  declaration: Record<string, unknown> | ((directory: string) => Record<string, unknown>),
) {
  const directory = await makeTempDir(t, "ae-shell-check-case-");
  const built = typeof declaration === "function" ? declaration(directory) : declaration;
  const casePath = join(directory, "case.yml");
  await writeFile(casePath, stringify({ input: "task", runner: { $type: "noop" }, ...built }));
  const registry = createRegistry();
  addRunner(registry, noopRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, mockChecker, "built-in");
  addChecker(registry, shellChecker, "built-in");
  const resultsDir = await makeTempDir(t, "ae-shell-check-results-");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent: await makeTempDir(t, "ae-shell-check-runs-"),
  });
  return { directory, record, resultsDir };
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
        { $type: "file", path: "artifact.txt", matches: "^made$" },
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
