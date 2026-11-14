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

type Part = string | { readonly env: string } | { readonly run: keyof RunVariables };

const BUILT_INS: readonly (keyof RunVariables)[] = ["HOME", "TMPDIR"];

/**
 * Split a string into literal text and placeholders: `${env:NAME}` reads the
 * invocation `.env`, `${NAME}` reads a built-in variable and `$${` is a literal `${`.
 */
function parse(text: string, where: string): Part[] {
  const parts: Part[] = [];
  let literal = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("$${", index)) {
      literal += "${";
      index += 3;
      continue;
    }
    if (!text.startsWith("${", index)) {
      literal += text[index];
      index += 1;
      continue;
    }
    const end = text.indexOf("}", index + 2);
    if (end < 0) throw new ConfigError(`unterminated "\${" in ${where}; write "$\${" for a literal`);
    const expression = text.slice(index + 2, end);
    const colon = expression.indexOf(":");
    const source = colon < 0 ? undefined : expression.slice(0, colon);
    const name = colon < 0 ? expression : expression.slice(colon + 1);
    if (!ENV_NAME_PATTERN.test(name)) throw new ConfigError(`invalid placeholder "\${${expression}}" in ${where}`);
    if (literal !== "") parts.push(literal);
    literal = "";
    if (source === "env") {
      parts.push({ env: name });
    } else if (source !== undefined) {
      throw new ConfigError(`unknown value source "${source}" in "\${${expression}}" in ${where} (available: env)`);
    } else if ((BUILT_INS as readonly string[]).includes(name)) {
      parts.push({ run: name as keyof RunVariables });
    } else {
      throw new ConfigError(
        `unknown variable "\${${name}}" in ${where} (built-in: ${BUILT_INS.join(", ")}); use "\${env:${name}}" for a .env value`,
      );
    }
    index = end + 1;
  }
  if (literal !== "" || parts.length === 0) parts.push(literal);
  return parts;
}

/** Reject malformed placeholders anywhere in a value without reading any source. */
export function checkPlaceholders(value: unknown, where: string): void {
  walk(value, where, (text, at) => {
    parse(text, at);
    return text;
  });
}

/**
 * Substitute every placeholder in every string of a parameter value. Substituted
 * text is not scanned again; keys and non-string values are unchanged.
 */
export async function substituteValues<T>(value: T, where: string, source: ValueSource): Promise<T> {
  const names = new Set<string>();
  walk(value, where, (text, at) => {
    for (const part of parse(text, at)) if (typeof part !== "string" && "env" in part) names.add(part.env);
    return text;
  });
  const env = new Map<string, string>();
  for (const name of names) env.set(name, await source.env.require(name));
  return walk(value, where, (text, at) =>
    parse(text, at)
      .map((part) => (typeof part === "string" ? part : "env" in part ? env.get(part.env)! : source.run[part.run]))
      .join(""),
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
