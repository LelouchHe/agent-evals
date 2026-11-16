import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { makeAcpAgent } from "./helpers/acp-agent.ts";
import { homeSource, isCaseInsensitive, runAcpCase } from "./helpers/home-case.ts";

test("a case cannot overwrite login state through a differently-cased path", async (t) => {
  const fixture = await makeAcpAgent(t, "success");
  await mkdir(join(fixture.login, ".auth"), { recursive: true });
  await writeFile(join(fixture.login, ".auth/token"), "original-token");
  await writeFile(join(fixture.login, ".auth/home"), "");
  const forged = await homeSource(fixture.root, "forged", "forged-token\n");
  const casePath = join(fixture.root, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "write the answer",
      files: { "~/.AUTH/TOKEN": `${forged}/today.md` },
      checks: [{ $type: "file", path: "answer.txt", matches: "model-a" }],
      runner: { $type: "acp", agent: "agent.yml" },
    }),
  );
  const insensitive = await isCaseInsensitive(fixture.root);
  const record = await runAcpCase(fixture.root, casePath, "alias");

  // The persistent login directory must be untouched through the whole run and copy-back.
  assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "original-token");
  if (insensitive) {
    // One file: the overlay must be refused rather than written through the login name.
    assert.equal(record.status, "error", record.error);
    assert.match(record.error ?? "", /login state/i);
  }
  // On a case-sensitive filesystem the two spellings are different files, so only the
  // persisted-login assertion above applies; no alias exists to refuse.
});

test("agent files cannot overwrite login state through a differently-cased path", async (t) => {
  const fixture = await makeAcpAgent(t, "success");
  await mkdir(join(fixture.login, ".auth"), { recursive: true });
  await writeFile(join(fixture.login, ".auth/token"), "original-token");
  const forged = await homeSource(fixture.root, "forged", "forged-token\n");
  const agentPath = join(fixture.root, "alias-agent.yml");
  await writeFile(agentPath, stringify({ ...fixture.config, files: { "~/.AUTH/TOKEN": `${forged}/today.md` } }));
  const casePath = join(fixture.root, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "write the answer",
      checks: [{ $type: "file", path: "answer.txt", matches: "model-a" }],
      runner: { $type: "acp", agent: "alias-agent.yml" },
    }),
  );
  const record = await runAcpCase(fixture.root, casePath, "agent-alias");
  assert.equal(record.status, "error", record.error);
  assert.match(record.error ?? "", /agent files and login/i);
  assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "original-token");
});
