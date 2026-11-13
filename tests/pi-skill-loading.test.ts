import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePiExecutable, createPiProcess } from "../src/runners/pi/session.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

test(
  "real Pi loads an explicit skill inside the isolated sandbox without a model call",
  { skip: process.platform !== "darwin" },
  async (t) => {
    let executable: string;
    try {
      executable = await resolvePiExecutable("pi");
    } catch {
      t.skip("Pi is not installed on PATH");
      return;
    }

    const root = await makeTempDir(t, "ae-pi-skill-");
    const workspaceDir = join(root, "workspace");
    const homeDir = join(root, "home");
    const configDir = join(root, "config");
    const scratchDir = join(root, "scratch");
    await Promise.all([mkdir(workspaceDir), mkdir(homeDir), mkdir(configDir), mkdir(scratchDir)]);
    await mkdir(join(configDir, "skills", "sample"), { recursive: true });
    await writeFile(
      join(configDir, "skills", "sample", "SKILL.md"),
      "---\nname: sample\ndescription: Sample skill for the loading test.\n---\n\nbody\n",
    );

    const process = await createPiProcess({
      executable,
      runRootDir: root,
      thinking: "medium",
      dirs: { workspaceDir, homeDir, configDir, scratchDir },
      skills: [join(configDir, "skills", "sample")],
      tools: ["read", "write"],
      allowNetwork: false,
    });
    t.after(() => process.stop());

    const data = (await process.command("get_commands")) as {
      commands?: Array<{ name?: string; source?: string; description?: string }>;
    };
    const skill = data.commands?.find((command) => command.source === "skill");
    assert.ok(skill !== undefined, `expected a loaded skill, got ${JSON.stringify(data.commands)}`);
    assert.equal(skill.name, "skill:sample");
    assert.equal(skill.description, "Sample skill for the loading test.");
  },
);

test("real Pi rejects malformed skill frontmatter", { skip: process.platform !== "darwin" }, async (t) => {
  let executable: string;
  try {
    executable = await resolvePiExecutable("pi");
  } catch {
    t.skip("Pi is not installed on PATH");
    return;
  }

  const root = await makeTempDir(t, "ae-pi-bad-skill-");
  const workspaceDir = join(root, "workspace");
  const homeDir = join(root, "home");
  const configDir = join(root, "config");
  const scratchDir = join(root, "scratch");
  await Promise.all([mkdir(workspaceDir), mkdir(homeDir), mkdir(configDir), mkdir(scratchDir)]);
  await mkdir(join(configDir, "skills", "broken"), { recursive: true });
  await writeFile(
    join(configDir, "skills", "broken", "SKILL.md"),
    "---\nname: broken\ndescription: [unterminated\n---\n\nbody\n",
  );

  const process = await createPiProcess({
    executable,
    runRootDir: root,
    thinking: "medium",
    dirs: { workspaceDir, homeDir, configDir, scratchDir },
    skills: [join(configDir, "skills", "broken")],
    tools: ["read"],
    allowNetwork: false,
  });
  t.after(() => process.stop());

  const data = (await process.command("get_commands")) as { commands?: Array<{ name?: string }> };
  assert.equal(
    data.commands?.some((command) => command.name === "skill:broken"),
    false,
  );
});
