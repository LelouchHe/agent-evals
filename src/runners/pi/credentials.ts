import type { CredentialSource } from "../../engine/credentials.ts";

/**
 * Explicit provider-to-credential mapping for the Pi providers currently
 * supported by this project. Unknown providers receive no injected credential.
 */
const PROVIDER_CREDENTIAL_ENV: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
  opencode: "OPENCODE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** Resolve the credential environment required by a Pi model selector. */
export async function resolveModelCredentialEnv(
  credentials: CredentialSource,
  model: string,
): Promise<Readonly<Record<string, string>>> {
  const provider = model.split("/", 1)[0] ?? "";
  const name = PROVIDER_CREDENTIAL_ENV[provider];
  if (name === undefined) {
    return {};
  }
  return { [name]: await credentials.require(name) };
}
