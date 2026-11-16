import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { makeAcpAgent } from "./helpers/acp-agent.ts";
import { runCliProcess } from "./helpers/cli-process.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

interface Reproduction {
  readonly name: string;
  readonly prepare: (fixture: Awaited<ReturnType<typeof makeAcpAgent>>) => Promise<Record<string, unknown>>;
}

async function runReproduction(t: TestContext, reproduction: Reproduction) {
  const fixture = await makeAcpAgent(t, "success");
  await mkdir(join(fixture.login, ".auth"), { recursive: true });
  await writeFile(join(fixture.login, ".auth/token"), "original-token");
  const second = await reproduction.prepare(fixture);
  const casePath = join(fixture.root, "cases.yml");
  await writeFile(
    casePath,
    stringify({
      input: "write the answer",
      checks: [{ $type: "file", path: "answer.txt", matches: "model-a" }],
      cases: {
        first: { runner: { $type: "acp", agent: "agent.yml" } },
        second,
      },
    }),
  );
  const resultsDir = join(fixture.root, "results");
  const result = await runCliProcess(t, CLI, ["run", casePath, "--results-dir", resultsDir], {
    cwd: fixture.root,
    env: { ...process.env, TMPDIR: fixture.runtime },
  });
  return { result, resultsDir, fixture };
}

test("a later case's HOME placement errors are found before any case runs", async (t) => {
  const reproductions: readonly Reproduction[] = [
    {
      name: "agent files source missing",
      async prepare(fixture) {
        const agentPath = join(fixture.root, "missing-source-agent.yml");
        await writeFile(agentPath, stringify({ ...fixture.config, files: { "~/settings.json": "not-there.json" } }));
        return { runner: { $type: "acp", agent: "missing-source-agent.yml" } };
      },
    },
    {
      name: "case ~/ directory contains a login file",
      async prepare(fixture) {
        await mkdir(join(fixture.root, "tree/.auth"), { recursive: true });
        await writeFile(join(fixture.root, "tree/.auth/token"), "forged-token\n");
        return { files: { "~/": "tree" }, runner: { $type: "acp", agent: "agent.yml" } };
      },
    },
    {
      name: "agent files directory contains a login file",
      async prepare(fixture) {
        await mkdir(join(fixture.root, "tree"), { recursive: true });
        await writeFile(join(fixture.root, "tree/token"), "forged-token\n");
        const agentPath = join(fixture.root, "tree-agent.yml");
        await writeFile(agentPath, stringify({ ...fixture.config, files: { "~/.auth": "tree" } }));
        return { runner: { $type: "acp", agent: "tree-agent.yml" } };
      },
    },
  ];
  for (const reproduction of reproductions) {
    const { result, resultsDir, fixture } = await runReproduction(t, reproduction);
    assert.equal(result.code, 2, `${reproduction.name}: ${result.stderr}`);
    assert.match(result.stderr, /configuration error/, reproduction.name);
    await assert.rejects(readdir(resultsDir), { code: "ENOENT" }, reproduction.name);
    assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "original-token");
  }
});
