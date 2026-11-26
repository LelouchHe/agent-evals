import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { z } from "zod";
import { fileChecker } from "../src/checkers/file/index.ts";
import { judgeChecker } from "../src/checkers/judge/index.ts";
import { mockChecker } from "../src/checkers/mock/index.ts";
import { shellChecker } from "../src/checkers/shell/index.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { noopRunner } from "../src/runners/noop/index.ts";
import { piRunner } from "../src/runners/pi/index.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "cases", "deploy-runbook-windows", "case.yml");

test("deploy-runbook-windows example loads cleanly for both with-skill and baseline cases", async () => {
  const withSkill = await loadCase(EXAMPLE, { caseName: "with-skill" });
  assert.equal(withSkill.name, "with-skill");
  assert.equal(withSkill.config.runner.$type, "pi");
  assert.equal(withSkill.config.checks.length, 4);

  const baseline = await loadCase(EXAMPLE, { caseName: "baseline" });
  assert.equal(baseline.name, "baseline");
  assert.equal(baseline.config.runner.$type, "noop");
});

test(
  "deploy-runbook-windows baseline fails positive checks and passes deploy.log restraint on Windows",
  { skip: process.platform !== "win32" },
  async (t) => {
    const resultsDir = await makeTempDir(t, "ae-win-example-results-");
    const tempParent = await makeTempDir(t, "ae-win-example-runs-");
    const registry = createRegistry();
    addRunner(registry, noopRunner, "built-in");
    addRunner(registry, piRunner, "built-in");
    addChecker(registry, fileChecker, "built-in");
    addChecker(registry, shellChecker, "built-in");
    addChecker(registry, judgeChecker, "built-in");

    const loaded = await loadCase(EXAMPLE, { caseName: "baseline" });
    // Drop the model judge check for the model-free noop baseline verification.
    const modelFree = {
      ...loaded,
      config: {
        ...loaded.config,
        checks: loaded.config.checks.filter((check) => check.$type !== "judge"),
      },
    };
    const record = await runEvaluation({
      case: modelFree,
      registry,
      resultsDir,
      tempParent,
    });
    assert.equal(record.status, "fail");
    assert.deepEqual(
      record.checks.map((c) => c.status),
      ["fail", "pass", "fail"],
    );
  },
);

test(
  "Windows mock forwarder intercepts both PATH .cmd and workspace .ps1 scripts",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = await makeTempDir(t, "ae-win-ps1-mock-");
    const fixtureDir = join(dir, "fixture");
    await mkdir(join(fixtureDir, "scripts"), { recursive: true });
    await writeFile(join(fixtureDir, "scripts", "deploy.ps1"), "Write-Output 'real-deploy'\n", "utf8");
    const casePath = join(dir, "case.yml");
    await writeFile(
      casePath,
      stringify({
        input: "run mocked tools",
        fixture: "fixture",
        mocks: {
          shell: {
            "ae-fake-cli": { return: { stdout: "mocked-cli-ok\n" } },
            "./scripts/deploy.ps1": { return: { stdout: "mocked-ps1-ok\n" } },
          },
        },
        runner: { $type: "win-mock-probe" },
        checks: [
          { $type: "mock", shell: ["ae-fake-cli", "status"] },
          { $type: "mock", shell: ["./scripts/deploy.ps1", "prod"] },
          { $type: "file", path: "probe.txt", matches: "mocked-cli-ok|mocked-ps1-ok" },
        ],
      }),
      "utf8",
    );

    const { spawnSync } = await import("node:child_process");
    const { delimiter } = await import("node:path");
    const registry = createRegistry();
    addChecker(registry, fileChecker, "built-in");
    addChecker(registry, mockChecker, "built-in");
    addRunner(
      registry,
      {
        type: "win-mock-probe",
        params: z.strictObject({}),
        async create() {
          return {
            async run(ctx) {
              const env = {
                ...process.env,
                PATH: [ctx.mocks!.forwarderDir, process.env.PATH ?? ""].join(delimiter),
              };
              const cliRes = spawnSync("cmd.exe", ["/d", "/c", "ae-fake-cli status"], {
                cwd: ctx.workspaceDir,
                env,
                encoding: "utf8",
                windowsHide: true,
              });
              const psRes = spawnSync(
                "powershell.exe",
                [
                  "-NoLogo",
                  "-NoProfile",
                  "-NonInteractive",
                  "-InputFormat",
                  "None",
                  "-ExecutionPolicy",
                  "Bypass",
                  "-File",
                  join(ctx.workspaceDir, "scripts", "deploy.ps1"),
                  "prod",
                ],
                { cwd: ctx.workspaceDir, env, encoding: "utf8", windowsHide: true },
              );
              await writeFile(
                join(ctx.workspaceDir, "probe.txt"),
                `${(cliRes.stdout ?? "").trim()}|${(psRes.stdout ?? "").trim()}\n`,
                "utf8",
              );
              return { finalText: "done", diagnostics: [] };
            },
            async stop() {},
          };
        },
      },
      "test",
    );

    const resultsDir = await makeTempDir(t, "ae-win-ps1-mock-results-");
    const tempParent = await makeTempDir(t, "ae-win-ps1-mock-runs-");
    const record = await runEvaluation({
      case: await loadCase(casePath),
      registry,
      resultsDir,
      tempParent,
    });
    assert.equal(record.status, "pass", record.error ?? JSON.stringify(record.checks));
    assert.equal(
      await readFile(join(resultsDir, record.runId, "result.json"), "utf8").then((s) => JSON.parse(s).status),
      "pass",
    );
  },
);
