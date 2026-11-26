import { basename } from "node:path";
import { Document, isMap, isNode, isScalar, isSeq, type Pair, type YAMLMap } from "yaml";
import type { FieldOrigin, ResolvedCase, SourceOrigin } from "./config.ts";
import type { PlacementSummary } from "./placement.ts";

export interface ViewOptions {
  /** What the case would place, computed by the caller (view starts no runtime). */
  readonly placement: readonly PlacementSummary[];
  /** List every placed and excluded path instead of the entry counts. */
  readonly files: boolean;
}

/** Render the resolved configuration with inline `# <file>:<line>` origins and placement. */
export function formatResolvedCase(resolved: ResolvedCase, options: ViewOptions): string {
  const lines = [
    `configuration: ${resolved.path}`,
    `case: ${resolved.name === undefined ? "(ordinary)" : JSON.stringify(resolved.name)}`,
    "resolved configuration:",
  ];
  for (const line of formatAnnotatedConfig(resolved).trimEnd().split("\n")) {
    lines.push(`  ${line}`);
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

const MAX_ALIGN_COLUMN = 44;

function formatAnnotatedConfig(resolved: ResolvedCase): string {
  const doc = new Document(resolved.config);
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
      const origin = resolved.origins[pair.key.value];
      if (origin === undefined) continue;
      applyOrigin(pair, origin);
    }
  }
  return alignOriginComments(doc.toString(), basename(resolved.path));
}

/**
 * Align trailing `# <file>:<line>` comments to one column, capped so a single long scalar
 * (such as `input`) never pushes every other line's comment far to the right.
 */
function alignOriginComments(yamlText: string, fileName: string): string {
  const suffix = new RegExp(`^(.*?) (# ${escapeRegExp(fileName)}:\\d+)$`, "u");
  const lines = yamlText.trimEnd().split("\n");
  const parsed = lines.map((line): { readonly line: string } | { readonly body: string; readonly comment: string } => {
    const match = suffix.exec(line);
    return match === null ? { line } : { body: match[1]!, comment: match[2]! };
  });
  let column = 0;
  for (const entry of parsed) {
    if ("comment" in entry && entry.body.length + 2 <= MAX_ALIGN_COLUMN) {
      column = Math.max(column, entry.body.length + 2);
    }
  }
  return parsed
    .map((entry) => {
      if (!("comment" in entry)) return entry.line;
      const pad = Math.max(2, column - entry.body.length);
      return `${entry.body}${" ".repeat(pad)}${entry.comment}`;
    })
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function applyOrigin(pair: Pair, origin: FieldOrigin): void {
  switch (origin.kind) {
    case "common":
    case "case":
      annotatePair(pair, formatSource(origin));
      return;
    case "list":
      if (!isSeq(pair.value)) return;
      for (const [index, item] of pair.value.items.entries()) {
        const entryOrigin = origin.items[index];
        if (entryOrigin === undefined) continue;
        const comment = formatSource(entryOrigin);
        if (isMap(item) && item.items[0] !== undefined) {
          annotatePair(item.items[0], comment);
        } else if (isNode(item)) {
          item.comment = comment;
        }
      }
      return;
    case "map":
      if (!isMap(pair.value)) return;
      annotateMap(pair.value, origin.entries);
      return;
    case "group":
      if (!isMap(pair.value)) return;
      for (const groupPair of pair.value.items) {
        if (!isScalar(groupPair.key) || typeof groupPair.key.value !== "string") continue;
        const childOrigin = origin.entries[groupPair.key.value];
        if (childOrigin !== undefined) {
          applyOrigin(groupPair, childOrigin);
        }
      }
      return;
  }
}

function annotateMap(map: YAMLMap, entries: Readonly<Record<string, SourceOrigin>>): void {
  for (const entryPair of map.items) {
    if (!isScalar(entryPair.key) || typeof entryPair.key.value !== "string") continue;
    const entryOrigin = entries[entryPair.key.value];
    if (entryOrigin !== undefined) {
      annotatePair(entryPair, formatSource(entryOrigin));
    }
  }
}

function annotatePair(pair: Pair, comment: string): void {
  if (isScalar(pair.value)) {
    pair.value.comment = comment;
  } else if (isNode(pair.key)) {
    pair.key.comment = comment;
  }
}

function formatSource(origin: SourceOrigin): string {
  return ` ${basename(origin.file)}:${origin.line}`;
}

function count(value: number, label: string): string {
  return `${value} ${label}`;
}
