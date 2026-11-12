import type { ImplementationContext } from "../../src/engine/registry.ts";

export function implementationContext(authoringDir: string): ImplementationContext {
  return { authoringDir };
}
