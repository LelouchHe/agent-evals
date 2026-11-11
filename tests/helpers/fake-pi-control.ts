import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export interface FakePi {
  readonly executable: string;
  readonly directory: string;
  readonly extraFile: string;
}

/** Create a temp directory with cleanup registered on the test context. */
export async function makeTempDir(t: TestContext, prefix = "ae-test-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return directory;
}

/**
 * Copy the fake Pi RPC process into a directory with a scenario selector.
 * The extra file is available to scenarios that need to record evidence.
 */
export async function createFakePi(t: TestContext, scenario: string, extra?: string): Promise<FakePi> {
  const directory = await makeTempDir(t, "ae-fake-");
  const executable = join(directory, "fake-pi.ts");
  await copyFile(new URL("./fake-pi.ts", import.meta.url), executable);
  await chmod(executable, 0o755);
  const extraFile = extra ?? join(directory, "extra");
  await writeFile(join(directory, "scenario"), `${scenario}\n${extraFile}\n`, "utf8");
  return { executable, directory, extraFile };
}
