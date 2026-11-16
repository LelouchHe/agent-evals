import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

async function context(
  t: TestContext,
  trace?: readonly TraceEntry[],
  skills: Readonly<Record<string, string>> = {},
  homeSkills: Readonly<Record<string, string>> = {},
): Promise<CheckerContext> {
  const root = await makeTempDir(t, "ae-trace-check-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  const home = join(root, "home");
  const homeBaseline = join(root, "home-baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  await mkdir(home);
  await mkdir(homeBaseline);
  for (const [relative, content] of Object.entries(skills)) {
    for (const directory of [workspace, baseline]) {
      await mkdir(dirname(join(directory, relative)), { recursive: true });
      await writeFile(join(directory, relative), content);
    }
  }
  for (const [relative, content] of Object.entries(homeSkills)) {
    for (const directory of [home, homeBaseline]) {
      await mkdir(dirname(join(directory, relative)), { recursive: true });
      await writeFile(join(directory, relative), content);
    }
  }
  return {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    home: await openRunRoot(home),
    homeBaseline: await openRunRoot(homeBaseline),
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

async function checkIn(context: CheckerContext, raw: ImplementationParams) {
  const params = await parseImplementationParams(traceChecker.params, raw, 'checker "trace"');
  const checker = await traceChecker.create(params, implementationContext(process.cwd()));
  return checker.check(context);
}

/** A completed shell tool call, as the harnesses that report one describe it. */
function shellCommand(command: string): ToolEntry {
  return {
    type: "tool",
    toolCallId: "call-shell",
    title: "bash",
    kind: "execute",
    status: "completed",
    rawInput: { command },
    content: [{ type: "content", content: { type: "text", text: "" } }],
  };
}

function parse(raw: ImplementationParams) {
  return parseImplementationParams(traceChecker.params, raw, 'checker "trace"');
}

function statuses(results: readonly CheckResult[]): readonly string[] {
  return results.map((result) => result.status);
}

/** A completed tool call whose returned text must stay out of the message artifact. */
function readTool(output: string): ToolEntry {
  return {
    type: "tool",
    toolCallId: "call-read",
    title: "cat deploy.log",
    kind: "execute",
    status: "completed",
    rawInput: { command: "cat deploy.log" },
    content: [{ type: "content", content: { type: "text", text: output } }],
  };
}

test("the trace checker rejects an unknown event, an extra key and a literal name with times above 1", async () => {
  await assert.rejects(
    () => parse({ event: "tool", name: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /accepted events: skill, message/);
      return true;
    },
  );
  await assert.rejects(
    () => parse({ event: "skill", name: "x", offset: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /accepts only event, name and times for a skill event; unexpected: offset/);
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
  assert.equal(
    (await check(t, { event: "skill", name: "deploy-runbook" }, trace))[0]?.reason,
    "found 1 consultation, consulted: deploy-runbook, deploy-native",
  );
  assert.deepEqual(statuses(await check(t, { event: "skill", name: "/^deploy-/" }, trace)), ["pass"]);
  assert.deepEqual(statuses(await check(t, { event: "skill", name: "/^deploy-/", times: 2 }, trace)), ["pass"]);
});

test("times 0 passes only when the run consulted no matching skill", async (t) => {
  const none = await check(t, { event: "skill", name: "deploy-runbook", times: 0 }, []);
  assert.deepEqual(statuses(none), ["pass"]);
  assert.equal(none[0]?.reason, "found 0 consultations, consulted: none");

  const other = await check(t, { event: "skill", name: "deploy-runbook", times: 0 }, [skillTool("markdown-writing")]);
  assert.deepEqual(statuses(other), ["pass"]);
  assert.equal(other[0]?.reason, "found 0 consultations, consulted: markdown-writing");

  const consulted = await check(t, { event: "skill", name: "deploy-runbook", times: 0 }, [skillTool("deploy-runbook")]);
  assert.deepEqual(statuses(consulted), ["fail"]);
  assert.equal(consulted[0]?.reason, "expected exactly 0 consultations of deploy-runbook, consulted: deploy-runbook");
});

test("a pattern with times 0 expresses that no skill was consulted at all", async (t) => {
  const none = await check(t, { event: "skill", name: "/.*/", times: 0 }, []);
  assert.deepEqual(statuses(none), ["pass"]);
  const any = await check(t, { event: "skill", name: "/.*/", times: 0 }, [skillTool("deploy-runbook")]);
  assert.deepEqual(statuses(any), ["fail"]);
});

test("a shell command naming a placed SKILL.md is reported but never counted", async (t) => {
  const skill = ".agents/skills/kb-directory/SKILL.md";
  const trace = [shellCommand(`cd ~ && head -40 ${skill}`)];
  const files = { [skill]: "---\nname: knowledge-base\n---\nbody\n" };

  const counted = await checkIn(await context(t, trace, files), { event: "skill", name: "knowledge-base" });
  assert.deepEqual(statuses(counted), ["fail"]);
  assert.equal(counted[0]?.reason, "expected knowledge-base, consulted: none; touched via shell: knowledge-base");

  const restraint = await checkIn(await context(t, trace, files), { event: "skill", name: "/.*/", times: 0 });
  assert.deepEqual(statuses(restraint), ["pass"]);
  assert.equal(restraint[0]?.reason, "found 0 consultations, consulted: none; touched via shell: knowledge-base");
});

test("a check sees a skill the case placed under ~/, while shell access stays uncounted", async (t) => {
  const read: ToolEntry = {
    type: "tool",
    toolCallId: "call-home",
    title: "read",
    kind: "read",
    status: "completed",
    locations: [{ path: "~/.claude/skills/aw-task-delegation/SKILL.md" }],
    rawInput: { path: "~/.claude/skills/aw-task-delegation/SKILL.md" },
    content: [{ type: "content", content: { type: "text", text: "# body after frontmatter\n" } }],
  };
  const traceContext = await context(
    t,
    [read, shellCommand("head -40 ~/.claude/skills/knowledge-base/SKILL.md")],
    {},
    {
      ".claude/skills/aw-task-delegation/SKILL.md": "---\nname: task-delegation\n---\nbody\n",
      ".claude/skills/knowledge-base/SKILL.md": "---\nname: knowledge-base\n---\nbody\n",
    },
  );

  const consulted = await checkIn(traceContext, { event: "skill", name: "task-delegation" });
  assert.deepEqual(statuses(consulted), ["pass"]);
  assert.equal(
    consulted[0]?.reason,
    "found 1 consultation, consulted: task-delegation; touched via shell: knowledge-base",
  );

  const shellOnly = await checkIn(traceContext, { event: "skill", name: "knowledge-base" });
  assert.deepEqual(statuses(shellOnly), ["fail"]);
  assert.equal(
    shellOnly[0]?.reason,
    "expected knowledge-base, consulted: task-delegation; touched via shell: knowledge-base",
  );
});

test("a shell command naming a SKILL.md the baseline did not place is not reported", async (t) => {
  const trace = [shellCommand("cat .agents/skills/agent-made/SKILL.md")];
  const contextWithTrace = await context(t, trace);
  const created = join(contextWithTrace.workspace.path, ".agents/skills/agent-made");
  await mkdir(created, { recursive: true });
  await writeFile(join(created, "SKILL.md"), "---\nname: agent-made\n---\n");

  const results = await checkIn(contextWithTrace, { event: "skill", name: "/.*/", times: 0 });
  assert.equal(results[0]?.reason, "found 0 consultations, consulted: none");
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
    /found 1 consultation, consulted: legacy-skill \(named from the parent directory, not frontmatter: legacy-skill\)/,
  );
});

test("event: message joins every message entry and leaves thoughts and tool output out", async (t) => {
  const trace: TraceEntry[] = [
    { type: "message", text: "Deploy " },
    { type: "thought", text: "E4127 means the publish was aborted." },
    { type: "message", text: "aborted: " },
    readTool("publish aborted with E4127"),
    { type: "message", text: "rollback started." },
  ];

  // A literal and a pattern are both searched within the join of every message entry.
  const joined = await check(t, { event: "message", matches: "aborted: rollback" }, trace);
  assert.deepEqual(statuses(joined), ["pass"]);
  assert.equal(joined[0]?.subject, 'message matches "aborted: rollback"');
  assert.equal(joined[0]?.reason, "pattern found");
  assert.deepEqual(statuses(await check(t, { event: "message", matches: "/^Deploy aborted:/" }, trace)), ["pass"]);

  // Reasoning and tool output are not text the agent produced for the user.
  assert.deepEqual(statuses(await check(t, { event: "message", matches: "E4127" }, trace)), ["fail"]);
  assert.deepEqual(statuses(await check(t, { event: "message", matches: "publish aborted" }, trace)), ["fail"]);
  assert.deepEqual(statuses(await check(t, { event: "message", notMatches: "/E4127/" }, trace)), ["pass"]);

  // Every declared pattern is one result, matches first, in declaration order.
  const declared = await check(
    t,
    { event: "message", matches: ["Deploy", "/rollback\\s+started/"], notMatches: "prune" },
    trace,
  );
  assert.deepEqual(statuses(declared), ["pass", "pass", "pass"]);
  assert.deepEqual(
    declared.map((result) => result.subject),
    ['message matches "Deploy"', "message matches /rollback\\s+started/", 'message does not match "prune"'],
  );

  const absent = await check(t, { event: "message", notMatches: "/abort(ed)?/" }, trace);
  assert.deepEqual(statuses(absent), ["fail"]);
  assert.equal(absent[0]?.subject, "message does not match /abort(ed)?/");
  assert.equal(absent[0]?.reason, "pattern found");
});

test("a trace holding no message text is an error, not a pass or a fail", async (t) => {
  for (const raw of [
    { event: "message", matches: "done" },
    { event: "message", notMatches: "done" },
  ]) {
    const results = await check(t, raw, []);
    assert.deepEqual(statuses(results), ["error"]);
    assert.match(results[0]?.reason ?? "", /holds no message text/);
  }

  // Reasoning alone is not text the agent produced, so a restraint check cannot pass here.
  const thoughtOnly = await check(t, { event: "message", notMatches: "done" }, [{ type: "thought", text: "done" }]);
  assert.deepEqual(statuses(thoughtOnly), ["error"]);

  const absent = await check(t, { event: "message", notMatches: "done" });
  assert.deepEqual(statuses(absent), ["error"]);
  assert.match(absent[0]?.reason ?? "", /records no trace/);
});

test("each event rejects the other event's parameters and names the field", async () => {
  const rejected: readonly (readonly [ImplementationParams, RegExp])[] = [
    [{ event: "skill", name: "deploy-runbook", matches: "x" }, /unexpected: matches/],
    [{ event: "skill", name: "deploy-runbook", notMatches: "x" }, /unexpected: notMatches/],
    [{ event: "message", matches: "x", name: "deploy-runbook" }, /unexpected: name/],
    [{ event: "message", matches: "x", times: 1 }, /unexpected: times/],
  ];
  for (const [raw, named] of rejected) {
    await assert.rejects(
      () => parse(raw),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, named);
        return true;
      },
    );
  }

  await assert.rejects(() => parse({ event: "message" }), /needs at least one of matches or notMatches/);
  await assert.rejects(() => parse({ event: "message", matches: [] }), /must hold at least one pattern/);
  await assert.rejects(
    () => parse({ event: "message", matches: "x", offset: 1 }),
    /accepts only event, matches and notMatches for a message event; unexpected: offset/,
  );
});
