import { ConfigError, ENV_NAME_PATTERN } from "./config.ts";
import type { EnvSource } from "./env-source.ts";

/** Built-in variables: the run's directories, known before they are created. */
export interface RunVariables {
  readonly HOME: string;
  readonly TMPDIR: string;
}

/** Everything a `${...}` placeholder can read. */
export interface ValueSource {
  readonly env: EnvSource;
  readonly run: RunVariables;
}

type Placeholder = { readonly env: string } | { readonly run: keyof RunVariables };

const BUILT_INS: readonly (keyof RunVariables)[] = ["HOME", "TMPDIR"];

/** `$${` is a literal `${`; `${...}` is a placeholder; any other `${` is unterminated. */
const TOKEN = /\$\$\{|\$\{([^}]*)\}|\$\{/g;

/**
 * Replace every token in a string: `${env:NAME}` reads the invocation `.env`,
 * `${NAME}` reads a built-in variable and `$${` is a literal `${`.
 */
function replace(text: string, where: string, resolve: (placeholder: Placeholder) => string): string {
  return text.replace(TOKEN, (token, expression: string | undefined) => {
    if (token === "$${") return "${";
    if (expression === undefined) throw new ConfigError(`unterminated "\${" in ${where}; write "$\${" for a literal`);
    return resolve(placeholder(expression, where));
  });
}

function placeholder(expression: string, where: string): Placeholder {
  const colon = expression.indexOf(":");
  const source = colon < 0 ? undefined : expression.slice(0, colon);
  const name = expression.slice(colon + 1);
  if (!ENV_NAME_PATTERN.test(name)) throw new ConfigError(`invalid placeholder "\${${expression}}" in ${where}`);
  if (source === "env") return { env: name };
  if (source !== undefined) {
    throw new ConfigError(`unknown value source "${source}" in "\${${expression}}" in ${where} (available: env)`);
  }
  if ((BUILT_INS as readonly string[]).includes(name)) return { run: name as keyof RunVariables };
  throw new ConfigError(
    `unknown variable "\${${name}}" in ${where} (built-in: ${BUILT_INS.join(", ")}); use "\${env:${name}}" for a .env value`,
  );
}

/** Reject malformed placeholders anywhere in a value without reading any source. */
export function checkPlaceholders(value: unknown, where: string): void {
  walk(value, where, (text, at) => replace(text, at, () => ""));
}

/**
 * Substitute every placeholder in every string of a parameter value. Substituted
 * text is not scanned again; keys and non-string values are unchanged.
 */
export async function substituteValues<T>(value: T, where: string, source: ValueSource): Promise<T> {
  // Collect every .env name first: lookups are asynchronous, replacement is not.
  const names = new Set<string>();
  walk(value, where, (text, at) =>
    replace(text, at, (found) => {
      if ("env" in found) names.add(found.env);
      return "";
    }),
  );
  const env = new Map<string, string>();
  for (const name of names) env.set(name, await source.env.require(name));
  return walk(value, where, (text, at) =>
    replace(text, at, (found) => ("env" in found ? env.get(found.env)! : source.run[found.run])),
  ) as T;
}

function walk(value: unknown, where: string, onString: (text: string, at: string) => string): unknown {
  if (typeof value === "string") return onString(value, where);
  if (Array.isArray(value)) return value.map((item, index) => walk(item, `${where}[${index}]`, onString));
  if (typeof value === "object" && value !== null) {
    // defineProperty keeps keys such as __proto__ as data for schema validation.
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        value: walk(item, `${where}.${key}`, onString),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return value;
}
