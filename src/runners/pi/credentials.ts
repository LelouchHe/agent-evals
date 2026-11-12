import type { CredentialSource } from "../../engine/credentials.ts";

/** Resolve the explicitly declared credential names for one Pi invocation. */
export async function resolveCredentialEnv(
  credentials: CredentialSource,
  names: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const values: Record<string, string> = {};
  for (const name of new Set(names)) {
    values[name] = await credentials.require(name);
  }
  return values;
}
