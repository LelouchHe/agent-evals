import { stringify } from "yaml";
import type { ResolvedCase } from "./config.ts";

/** Render the resolved configuration and one origin annotation per top-level field. */
export function formatResolvedCase(resolved: ResolvedCase): string {
  const lines = [
    `configuration: ${resolved.path}`,
    `case: ${resolved.name === undefined ? "(ordinary)" : JSON.stringify(resolved.name)}`,
    "resolved configuration:",
  ];

  const yamlText = stringify(resolved.config).trimEnd();
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
