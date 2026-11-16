import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { implementationContext } from "../../../tests/helpers/implementation-context.ts";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import type { CheckerContext, CheckResult, TraceEntry } from "../../engine/registry.ts";
import { openRunRoot } from "../../engine/workspace.ts";
import { traceChecker } from "./index.ts";

type ToolEntry = Extract<TraceEntry, { type: "tool" }>;

function skillTool(name: string): ToolEntry {
  return {
    type: "tool",
    toolCallId: `call-${name}`,
    title: `Load skill: ${name}`,
    kind: "other",
    status: "completed",
    content: [],
    rawInput: { skill: name },
    rawOutput: `Launching skill: ${name}`,
  };
}

async function context(t: TestContext, trace?: readonly TraceEntry[]): Promise<CheckerContext> {
  const root = await makeTempDir(t, "ae-trace-check-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  return {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    runRootDir: root,
    input: "task",
    ...(trace === undefined ? {} : { trace }),
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
    checkSandbox: {
      run: () => Promise.reject(new Error("this test wires no check sandbox")),
    },
  };
}

async function check(t: TestContext, raw: ImplementationParams, trace?: readonly TraceEntry[]) {
  const params = await parseImplementationParams(traceChecker.params, raw, 'checker "trace"');
  const checker = await traceChecker.create(params, implementationContext(process.cwd()));
  return checker.check(await context(t, trace));
}

function parse(raw: ImplementationParams) {
  return parseImplementationParams(traceChecker.params, raw, 'checker "trace"');
}

function statuses(results: readonly CheckResult[]): readonly string[] {
  return results.map((result) => result.status);
}

test("the trace checker rejects an unknown event, an extra key and a literal name with times above 1", async () => {
  await assert.rejects(
    () => parse({ event: "tool", name: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /accepted events: skill/);
      return true;
    },
  );
  await assert.rejects(
    () => parse({ event: "skill", name: "x", offset: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /accepts only event, name and times/);
      return true;
    },
  );
  await assert.rejects(
    () => parse({ event: "skill", name: "deploy-runbook", times: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /must be 0 or 1 with a literal name/);
      return true;
    },
  );
  // A pattern can match several skills, so any count is meaningful.
  await parse({ event: "skill", name: "/^deploy-/", times: 2 });
});

test("a literal name matches one exact skill, while a pattern is searched", async (t) => {
  const trace = [skillTool("deploy-runbook"), skillTool("deploy-native")];

  const literal = await check(t, { event: "skill", name: "deploy" }, trace);
  assert.deepEqual(statuses(literal), ["fail"]);
  assert.equal(literal[0]?.reason, "expected deploy, consulted: deploy-runbook, deploy-native");

  assert.deepEqual(statuses(await check(t, { event: "skill", name: "deploy-runbook" }, trace)), ["pass"]);
  assert.equal((await check(t, { event: "skill", name: "deploy-runbook" }, trace))[0]?.reason, "found 1 consultation");
  assert.deepEqual(statuses(await check(t, { event: "skill", name: "/^deploy-/" }, trace)), ["pass"]);
  assert.deepEqual(statuses(await check(t, { event: "skill", name: "/^deploy-/", times: 2 }, trace)), ["pass"]);
});

test("times 0 passes only when the run consulted no matching skill", async (t) => {
  const none = await check(t, { event: "skill", name: "deploy-runbook", times: 0 }, []);
  assert.deepEqual(statuses(none), ["pass"]);
  assert.equal(none[0]?.reason, "found 0 consultations");

  const consulted = await check(t, { event: "skill", name: "deploy-runbook", times: 0 }, [skillTool("deploy-runbook")]);
  assert.deepEqual(statuses(consulted), ["fail"]);
  assert.equal(consulted[0]?.reason, "expected exactly 0 consultations of deploy-runbook, consulted: deploy-runbook");
});

test("a runner without a trace is an error, not a pass or a fail", async (t) => {
  const results = await check(t, { event: "skill", name: "deploy-runbook", times: 0 });
  assert.deepEqual(statuses(results), ["error"]);
  assert.match(results[0]?.reason ?? "", /records no trace/);
});

test("the result says when a matched name is only the parent directory", async (t) => {
  const root = await makeTempDir(t, "ae-trace-outside-");
  const path = join(root, "skills", "legacy-skill", "SKILL.md");
  const results = await check(t, { event: "skill", name: "legacy-skill" }, [
    {
      type: "tool",
      toolCallId: "call-1",
      title: "read",
      kind: "read",
      status: "completed",
      locations: [{ path }],
      rawInput: { path },
      content: [{ type: "content", content: { type: "text", text: "# No frontmatter\n" } }],
    },
  ]);
  assert.deepEqual(statuses(results), ["pass"]);
  assert.match(
    results[0]?.reason ?? "",
    /found 1 consultation \(named from the parent directory, not frontmatter: legacy-skill\)/,
  );
});
