import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import type { TraceEntry } from "./registry.ts";
import { skillConsultations } from "./skills.ts";
import { openRunRoot } from "./workspace.ts";

type ToolEntry = Extract<TraceEntry, { type: "tool" }>;

const SKILL_BODY = "# Runbook\n\nFind the error code and apply the matching fix.\n";

async function runRoots(t: TestContext) {
  const root = await makeTempDir(t, "ae-skills-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  return { root, workspace, baseline };
}

/** A `SKILL.md` as the fixture places it: identical in the workspace and the baseline. */
/** The two run directories the derivation reads. */
async function sources(dirs: Awaited<ReturnType<typeof runRoots>>) {
  return { workspace: await openRunRoot(dirs.workspace), baseline: await openRunRoot(dirs.baseline) };
}

async function placeSkill(workspace: string, baseline: string, path: string, frontmatter: string): Promise<void> {
  const text = `---\n${frontmatter}---\n${SKILL_BODY}`;
  for (const root of [workspace, baseline]) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** A completed Pi read of `path`, with the returned text in the shapes Pi reports. */
function piRead(path: string, returned: string, extra: Record<string, unknown> = {}): ToolEntry {
  return {
    type: "tool",
    toolCallId: `call-${path}`,
    title: "read",
    kind: "read",
    status: "completed",
    locations: [{ path }],
    rawInput: { path, offset: null, limit: null },
    content: [{ type: "content", content: { type: "text", text: returned } }],
    rawOutput: { content: [{ type: "text", text: returned }] },
    ...extra,
  };
}

/** A completed Claude Code or Copilot CLI skill tool call. */
function skillTool(name: string, title = `Load skill: ${name}`): ToolEntry {
  return {
    type: "tool",
    toolCallId: `call-${name}`,
    title,
    name: "Skill",
    kind: "other",
    status: "completed",
    content: [],
    rawInput: { skill: name },
    rawOutput: `Launching skill: ${name}`,
  };
}

test("both harness forms are recognized and a skill is one consultation however often it is read", async (t) => {
  const dirs = await runRoots(t);
  await placeSkill(dirs.workspace, dirs.baseline, ".agents/skills/deploy-runbook/SKILL.md", "name: deploy-runbook\n");
  const skillFile = join(dirs.workspace, ".agents/skills/deploy-runbook/SKILL.md");
  const roots = await sources(dirs);

  const consultations = await skillConsultations(
    [
      skillTool("deploy-runbook"),
      piRead(skillFile, `---\nname: deploy-runbook\n---\n${SKILL_BODY}`, { rawInput: { path: skillFile, offset: 1 } }),
      skillTool("release-notes", "Using skill: release-notes"),
    ],
    roots,
  );

  assert.deepEqual(consultations, [
    { name: "deploy-runbook", fromDirectory: false },
    { name: "release-notes", fromDirectory: false },
  ]);
});

test("only completed calls count, and a read must name SKILL.md", async (t) => {
  const dirs = await runRoots(t);
  const skillFile = join(dirs.workspace, ".agents/skills/unused/SKILL.md");
  const roots = await sources(dirs);

  const consultations = await skillConsultations(
    [
      { ...skillTool("pending-skill"), status: "pending" },
      { ...skillTool("failed-skill"), status: "failed" },
      { ...piRead(skillFile, SKILL_BODY), status: "failed" },
      piRead(join(dirs.workspace, "deploy.log"), "failed\n"),
      skillTool("used-skill"),
    ],
    roots,
  );

  assert.deepEqual(consultations, [{ name: "used-skill", fromDirectory: false }]);
});

test("a read target comes from locations, rawInput.path or rawInput.file_path", async (t) => {
  const dirs = await runRoots(t);
  const relative = ".agents/skills/deploy-runbook/SKILL.md";
  await placeSkill(dirs.workspace, dirs.baseline, relative, "name: deploy-runbook\n");
  const returned = `---\nname: deploy-runbook\n---\n${SKILL_BODY}`;
  const roots = await sources(dirs);

  const consultations = await skillConsultations(
    [
      piRead(relative, returned, { locations: [{ path: relative }], rawInput: { offset: 1 } }),
      piRead(relative, returned, { locations: [], rawInput: { path: relative } }),
      piRead(relative, returned, { locations: [], rawInput: { file_path: relative } }),
    ],
    roots,
  );

  assert.deepEqual(consultations, [{ name: "deploy-runbook", fromDirectory: false }]);
});

test("a workspace read is named from the baseline in every path spelling, not from its output", async (t) => {
  const dirs = await runRoots(t);
  // The directory name differs from the skill's name, so the baseline frontmatter is the only
  // source that can produce `deploy-runbook` here.
  const relative = ".agents/skills/aw-deploy/SKILL.md";
  await placeSkill(dirs.workspace, dirs.baseline, relative, "name: deploy-runbook\n");
  const workspace = await openRunRoot(dirs.workspace);
  const roots = await sources(dirs);
  // An agent that edits the body during the run must not change the name.
  const edited = `---\nname: edited-during-run\n---\n${SKILL_BODY}`;

  const spellings = [relative, join(workspace.path, relative)];
  // `/var/…` and `/private/var/…` are the same directory under two spellings.
  if (workspace.path.startsWith("/private/")) {
    spellings.push(join(workspace.path.slice("/private".length), relative));
  }
  // Any other canonicalising spelling, such as an operator's symlinked temporary root.
  const alias = join(await makeTempDir(t, "ae-skills-alias-"), "run");
  await symlink(dirname(workspace.path), alias);
  spellings.push(join(alias, "workspace", relative));

  const consultations = await skillConsultations(
    spellings.map((path) => piRead(path, edited)),
    roots,
  );

  assert.deepEqual(consultations, [{ name: "deploy-runbook", fromDirectory: false }]);
});

// Nothing about a run root's layout may decide where a trace path is resolved. A workspace and
// a baseline that are not siblings still name a placed skill from the baseline's frontmatter.
test("workspace paths resolve against the given workspace, not the baseline's location", async (t) => {
  const workspaceDir = await makeTempDir(t, "ae-skills-workspace-");
  const baselineDir = await makeTempDir(t, "ae-skills-baseline-");
  const relative = ".agents/skills/aw-deploy/SKILL.md";
  await placeSkill(workspaceDir, baselineDir, relative, "name: deploy-runbook\n");
  const workspace = await openRunRoot(workspaceDir);
  const baseline = await openRunRoot(baselineDir);
  // The body the run returned was edited, so only the baseline frontmatter names the skill.
  const edited = `---\nname: edited-during-run\n---\n${SKILL_BODY}`;

  const consultations = await skillConsultations([piRead(join(workspace.path, relative), edited)], {
    workspace,
    baseline,
  });

  assert.deepEqual(consultations, [{ name: "deploy-runbook", fromDirectory: false }]);
});

test("agent-planted symlinks or loops in the live workspace neither hide the baseline name nor throw", async (t) => {
  const dirs = await runRoots(t);
  const outside = await makeTempDir(t, "ae-skills-outside-");
  const relative = ".agents/skills/aw-deploy/SKILL.md";
  await placeSkill(dirs.workspace, dirs.baseline, relative, "name: deploy-runbook\n");
  await placeSkill(dirs.workspace, dirs.baseline, ".agents/skills/other/SKILL.md", "name: baseline-other\n");

  // Simulate an agent reading a chunk past frontmatter, then replacing the skill directory in the
  // live workspace with an escaping symlink and leaving a symlink loop elsewhere.
  const { rm } = await import("node:fs/promises");
  await rm(join(dirs.workspace, ".agents/skills/aw-deploy"), { recursive: true });
  await symlink(outside, join(dirs.workspace, ".agents/skills/aw-deploy"));
  await symlink(dirs.workspace, join(outside, "ws-alias"));
  await symlink("loop-b", join(dirs.workspace, "loop-a"));
  await symlink("loop-a", join(dirs.workspace, "loop-b"));

  const roots = await sources(dirs);
  const consultations = await skillConsultations(
    [
      piRead(join(roots.workspace.path, relative), "# body chunk past frontmatter\n"),
      piRead(join(roots.workspace.path, "loop-a/SKILL.md"), ""),
      // An escaping workspace symlink that loops back through an external alias must not map into baseline.
      piRead(join(roots.workspace.path, ".agents/skills/aw-deploy/ws-alias/.agents/skills/other/SKILL.md"), ""),
    ],
    roots,
  );

  assert.deepEqual(consultations, [
    { name: "deploy-runbook", fromDirectory: false },
    { name: "loop-a", fromDirectory: true },
    { name: "other", fromDirectory: true },
  ]);
});

test("whitespace-only skill names and frontmatter names are ignored, and paths are not trimmed", async (t) => {
  const dirs = await runRoots(t);
  await placeSkill(dirs.workspace, dirs.baseline, ".agents/skills/aw-deploy/SKILL.md", "name: deploy-runbook\n");
  const roots = await sources(dirs);

  const consultations = await skillConsultations(
    [
      skillTool("   "),
      piRead(join(dirs.root, "home/skills/fallback-dir/SKILL.md"), "---\nname: '   '\n---\n"),
      // A distinct filename with a trailing space is not SKILL.md and must not consult baseline.
      piRead(".agents/skills/aw-deploy/SKILL.md ", "# decoy\n"),
    ],
    roots,
  );

  assert.deepEqual(consultations, [{ name: "fallback-dir", fromDirectory: true }]);
});

test("a read outside the workspace is named from its text, then from its parent directory", async (t) => {
  const dirs = await runRoots(t);
  const home = join(dirs.root, "home", "skills");
  await mkdir(join(home, "named-dir"), { recursive: true });
  await mkdir(join(home, "legacy-skill"), { recursive: true });
  const roots = await sources(dirs);

  const consultations = await skillConsultations(
    [
      // Chunked reads of one external skill across relative and absolute spellings: chunks without
      // frontmatter must not add a second directory-fallback consultation alongside the frontmatter name.
      piRead(join("..", "home", "skills", "named-dir", "SKILL.md"), "# Later chunk first\n"),
      {
        ...piRead(join(home, "named-dir/SKILL.md"), `---\nname: harness-skill\n---\n${SKILL_BODY}`),
        // The returned text may also arrive only as a string.
        content: [],
        rawOutput: `---\nname: harness-skill\n---\n${SKILL_BODY}`,
      },
      piRead(join(home, "named-dir/SKILL.md"), "# Trailing chunk without frontmatter\n"),
      piRead(join(home, "legacy-skill/SKILL.md"), "# No frontmatter in any chunk\n"),
    ],
    roots,
  );

  assert.deepEqual(consultations, [
    { name: "harness-skill", fromDirectory: false },
    { name: "legacy-skill", fromDirectory: true },
  ]);

  // Post-read symlink replacement in an external directory cannot erase an already-returned frontmatter name.
  await mkdir(join(home, "allowed"), { recursive: true });
  await symlink(join(home, "allowed"), join(home, "forbidden"));
  const afterSwap = await skillConsultations(
    [
      piRead(join(home, "allowed/SKILL.md"), `---\nname: allowed-skill\n---\n${SKILL_BODY}`),
      piRead(join(home, "forbidden/SKILL.md"), `---\nname: forbidden-skill\n---\n${SKILL_BODY}`),
    ],
    roots,
  );
  assert.deepEqual(afterSwap, [
    { name: "allowed-skill", fromDirectory: false },
    { name: "forbidden-skill", fromDirectory: false },
  ]);
});

test("a workspace read falls back to the returned text when the baseline gives no name", async (t) => {
  const dirs = await runRoots(t);
  const relative = ".agents/skills/plain/SKILL.md";
  await placeSkill(dirs.workspace, dirs.baseline, relative, "description: no name\n");
  const roots = await sources(dirs);

  const consultations = await skillConsultations([piRead(relative, `---\nname: text-name\n---\n${SKILL_BODY}`)], roots);

  assert.deepEqual(consultations, [{ name: "text-name", fromDirectory: false }]);
});
