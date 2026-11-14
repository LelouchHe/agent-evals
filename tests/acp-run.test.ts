import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { fileChecker } from "../src/checkers/file/checker.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { acpRunner } from "../src/runners/acp/runner.ts";
import { makeAcpAgent } from "./helpers/acp-agent.ts";

const INPUT = "Write the answer.";

/** Run one case against the model-free ACP peer; `.auth/requests` in login records its protocol calls. */
async function runCase(
  t: TestContext,
  scenario: string,
  runner: (fixture: Awaited<ReturnType<typeof makeAcpAgent>>) => Record<string, unknown>,
  signal?: AbortSignal,
) {
  const fixture = await makeAcpAgent(t, scenario);
  await mkdir(join(fixture.login, ".auth"), { recursive: true });
  await writeFile(join(fixture.login, ".auth/requests"), "[]");
  const casePath = join(fixture.root, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: INPUT,
      checks: [{ $type: "file", path: "answer.txt", matches: `^model-b: ${INPUT}$` }],
      runner: { $type: "acp", ...runner(fixture) },
    }),
  );
  const registry = createRegistry();
  addRunner(registry, acpRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir: join(fixture.root, "results"),
    tempParent: fixture.runtime,
    ...(signal === undefined ? {} : { signal }),
  });
  const requests = JSON.parse(await readFile(join(fixture.login, ".auth/requests"), "utf8")) as string[];
  return { fixture, record, requests };
}

test(
  "acp runner applies session config, prompts in the workspace and records the merged trace",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { fixture, record, requests } = await runCase(t, "success", () => ({
      agent: "agent.yml",
      config: { model: "model-b" },
    }));
    assert.equal(record.status, "pass", record.error);
    assert.equal(record.runner.finalText, "wrote answer");
    // Updates replace the fields they carry; null leaves the previous value.
    assert.deepEqual(JSON.parse(await readFile(join(fixture.root, "results", record.runId, "trace.json"), "utf8")), [
      { type: "thought", text: "plan it" },
      { type: "message", text: "draft" },
      {
        type: "tool",
        toolCallId: "call-1",
        title: "echo hi",
        kind: "execute",
        rawInput: { command: "echo hi" },
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hi" } }],
      },
      { type: "message", text: "wrote answer" },
    ]);
    assert.deepEqual(requests, ["initialize", "session/new", "session/set_config_option", "session/prompt"]);
    assert.deepEqual(await readdir(fixture.runtime), []);
  },
);

test(
  "acp runner rejects a session config value the agent does not offer before prompting",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { record, requests } = await runCase(t, "success", (fixture) => ({
      agent: fixture.config,
      config: { model: "model-z" },
    }));
    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /does not offer "model-z" \(available: model-a, model-b\)/);
    assert.deepEqual(requests, ["initialize", "session/new"]);
  },
);

test(
  "cancelling a hung ACP turn stops the sandbox and cleans up",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const abort = new AbortController();
    let fixture: Awaited<ReturnType<typeof makeAcpAgent>> | undefined;
    const prompted = (async () => {
      // The peer writes answer.txt when the prompt arrives, then hangs.
      for (;;) {
        const [run] = fixture === undefined ? [] : await readdir(fixture.runtime);
        const files = run === undefined ? [] : await readdir(join(fixture!.runtime, run, "workspace")).catch(() => []);
        if (files.includes("answer.txt")) return abort.abort();
        await delay(20, undefined, { signal: t.signal });
      }
    })();
    const result = await runCase(
      t,
      "hang",
      (created) => {
        fixture = created;
        return { agent: created.config };
      },
      abort.signal,
    );
    await prompted;
    assert.equal(result.record.status, "cancelled");
    assert.equal(result.requests.at(-1), "session/prompt");
    assert.deepEqual(await readdir(result.fixture.runtime), []);
  },
);
