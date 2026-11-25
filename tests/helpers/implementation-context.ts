import { validateCheckFiles } from "../../src/engine/files.ts";
import type { CheckSandbox, ImplementationContext } from "../../src/engine/registry.ts";

/** A check sandbox for tests that exercise no program, such as the file and judge checkers. */
export const unusedCheckSandbox: CheckSandbox = {
  run: () => Promise.reject(new Error("this test wires no check sandbox")),
};

export function implementationContext(authoringDir: string, runnerSupportsHome = true): ImplementationContext {
  return {
    authoringDir,
    runnerSupportsHome,
    validateCheckPlatform: async () => {},
    validateFiles: (files) => validateCheckFiles(files, authoringDir),
    createRunner: () => Promise.reject(new Error("this test creates no runner")),
    values: {
      env: {
        require: (name) => Promise.reject(new Error(`no environment value ${name} in this test`)),
      },
      run: { HOME: "/run/home", TMPDIR: "/run/tmp" },
    },
  };
}
