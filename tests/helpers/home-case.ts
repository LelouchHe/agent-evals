import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileChecker } from "../../src/checkers/file/index.ts";
import { loadCase } from "../../src/engine/authoring.ts";
import { addChecker, addRunner, createRegistry } from "../../src/engine/registry.ts";
import { runEvaluation } from "../../src/engine/run.ts";
import { acpRunner } from "../../src/runners/acp/index.ts";
import { noopRunner } from "../../src/runners/noop/index.ts";
import { makeTempDir } from "./fake-pi-control.ts";

/** The built-ins a HOME placement case needs. */
export function homeRegistry() {
  const value = createRegistry();
  addRunner(value, acpRunner, "built-in");
  addRunner(value, noopRunner, "built-in");
  addChecker(value, fileChecker, "built-in");
  return value;
}

/** Run one case in process, creating its temporary run parent. */
export async function runAcpCase(root: string, casePath: string, name: string) {
  const runs = join(root, "runs");
  await mkdir(runs, { recursive: true });
  return runEvaluation({
    case: await loadCase(casePath),
    registry: homeRegistry(),
    resultsDir: join(root, `results-${name}`),
    tempParent: runs,
  });
}

/** One authoring directory with a `today.md` source file, relative to `root`. */
export async function homeSource(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "today.md"), content);
  return name;
}

/** Whether this filesystem treats two spellings of one name as one path. */
export async function isCaseInsensitive(dir: string): Promise<boolean> {
  const probe = join(dir, "case-probe");
  await writeFile(probe, "probe\n");
  try {
    await lstat(join(dir, "CASE-PROBE"));
    return true;
  } catch {
    return false;
  }
}

/** A throwaway directory for tests that need more than one. */
export function tempRoot(t: TestContext): Promise<string> {
  return makeTempDir(t, "ae-home-case-");
}
