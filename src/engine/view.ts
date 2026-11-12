import { Scalar, stringify } from "yaml";
import type { ResolvedCase } from "./config.ts";

/** Render the resolved configuration and one origin annotation per top-level field. */
export function formatResolvedCase(resolved: ResolvedCase): string {
  const lines = [
    `configuration: ${resolved.path}`,
    `case: ${resolved.name === undefined ? "(ordinary)" : JSON.stringify(resolved.name)}`,
    "resolved configuration:",
  ];

  const yamlText = stringify(viewValue(resolved.config, resolved.references, [])).trimEnd();
  for (const line of yamlText.split("\n")) {
    lines.push(`  ${line}`);
  }

  lines.push("field origins:");
  for (const [field, origin] of Object.entries(resolved.origins)) {
    const source = origin.kind === "common" ? "common" : `case ${JSON.stringify(origin.caseName)}`;
    lines.push(`  ${field}: ${source} ${origin.file}:${origin.line}`);
  }
  return lines.join("\n") + "\n";
}

/** Preserve the declaration's reference-versus-literal distinction in view output. */
function viewValue(
  value: unknown,
  references: ResolvedCase["references"],
  path: readonly (string | number)[],
): unknown {
  const reference = references.find((candidate) => samePath(candidate.path, path));
  if (reference !== undefined) {
    return scalar(`$env:${reference.name}`, Scalar.PLAIN);
  }
  if (typeof value === "string") {
    return value.startsWith("$env:") ? scalar(value, Scalar.QUOTE_DOUBLE) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => viewValue(item, references, [...path, index]));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, viewValue(item, references, [...path, key])]),
    );
  }
  return value;
}

function scalar(value: string, type: Scalar["type"]): Scalar {
  const node = new Scalar(value);
  node.type = type;
  return node;
}

function samePath(left: readonly (string | number)[], right: readonly (string | number)[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
