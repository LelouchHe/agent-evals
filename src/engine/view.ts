import { stringify } from "yaml";
import type { ResolvedCase } from "./config.ts";

/** Render the declared configuration, placeholders unsubstituted, and one origin per top-level field. */
export function formatResolvedCase(resolved: ResolvedCase): string {
  const lines = [
    `configuration: ${resolved.path}`,
    `case: ${resolved.name === undefined ? "(ordinary)" : JSON.stringify(resolved.name)}`,
    "resolved configuration:",
  ];
  for (const line of stringify(resolved.config).trimEnd().split("\n")) {
    lines.push(`  ${line}`);
  }
  lines.push("field origins:");
  for (const [field, origin] of Object.entries(resolved.origins)) {
    const source = origin.kind === "common" ? "common" : `case ${JSON.stringify(origin.caseName)}`;
    lines.push(`  ${field}: ${source} ${origin.file}:${origin.line}`);
  }
  return lines.join("\n") + "\n";
}
