import { createCredentialSource } from "../../src/engine/credentials.ts";
import type { ImplementationContext } from "../../src/engine/registry.ts";

export function implementationContext(authoringDir: string): ImplementationContext {
  return { authoringDir, credentials: createCredentialSource(authoringDir) };
}
