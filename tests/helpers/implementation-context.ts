import type { ImplementationContext } from "../../src/engine/registry.ts";

export function implementationContext(authoringDir: string): ImplementationContext {
  return {
    authoringDir,
    values: {
      env: {
        require: (name) => Promise.reject(new Error(`no environment value ${name} in this test`)),
      },
      run: { HOME: "/run/home", TMPDIR: "/run/tmp" },
    },
  };
}
