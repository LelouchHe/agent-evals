import { stringify } from "yaml";
import type { ResolvedCase } from "./config.ts";
import type { PlacementSummary } from "./placement.ts";

export interface ViewOptions {
  /** What the case would place, computed by the caller (view starts no runtime). */
  readonly placement: readonly PlacementSummary[];
  /** List every placed and excluded path instead of the entry counts. */
  readonly files: boolean;
}

/** Render the declared configuration, its field origins and what it would place. */
export function formatResolvedCase(resolved: ResolvedCase, options: ViewOptions): string {
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
  lines.push("placement:");
  if (options.placement.length === 0) {
    lines.push("  none");
  }
  for (const summary of options.placement) {
    lines.push(
      `  ${summary.label}: ${count(summary.placed.length, "placed")}, ${count(summary.excluded.length, "excluded")}`,
    );
    if (!options.files) {
      continue;
    }
    for (const placed of summary.placed) {
      lines.push(`    place   ${placed.path} <- ${placed.source}`);
    }
    for (const excluded of summary.excluded) {
      const kind = excluded.directory ? " (directory)" : "";
      lines.push(`    exclude ${excluded.path}${kind} <- .agentevalsignore at ${excluded.ignoreDir}`);
    }
  }
  return lines.join("\n") + "\n";
}

function count(value: number, label: string): string {
  return `${value} ${label}`;
}
