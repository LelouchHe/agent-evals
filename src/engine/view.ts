import { basename } from "node:path";
import { Document, isMap, isNode, isScalar, isSeq, type Pair } from "yaml";
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
 * Align trailing `# <file>:<line>` (plus optional `(overrides ...)`) comments to one column,
 * capped so a single long scalar (such as `input`) never pushes other comments far to the right.
 */
function alignOriginComments(yamlText: string, fileName: string): string {
  const escaped = escapeRegExp(fileName);
  const suffix = new RegExp(`^(.*?) (# ${escaped}:\\d+(?: \\(overrides ${escaped}:\\d+\\))?)$`, "u");
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
  const uniform = uniformSource(origin);
  if (uniform !== undefined) {
    annotatePair(pair, formatSource(uniform));
    return;
  }
  if (origin.kind === "list") {
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
  }
  if (origin.kind === "map") {
    if (!isMap(pair.value)) return;
    for (const entryPair of pair.value.items) {
      if (!isScalar(entryPair.key) || typeof entryPair.key.value !== "string") continue;
      const childOrigin = origin.entries[entryPair.key.value];
      if (childOrigin !== undefined) {
        applyOrigin(entryPair, childOrigin);
      }
    }
  }
}

/**
 * If an entire field or subtree originates from one block (`common` or `case`) with no overrides,
 * return that single source so `view` annotates only the highest node instead of every entry.
 */
function uniformSource(origin: FieldOrigin): SourceOrigin | undefined {
  if (origin.kind === "common" || origin.kind === "case") {
    return origin;
  }
  if (origin.kind === "list") {
    const allSame = origin.items.every((item) => item.kind === origin.base.kind && item.overrides === undefined);
    return allSame ? origin.base : undefined;
  }
  const children = Object.values(origin.entries);
  const allSame = children.every((child) => {
    const sub = uniformSource(child);
    return sub !== undefined && sub.kind === origin.base.kind && sub.overrides === undefined;
  });
  return allSame ? origin.base : undefined;
}

function annotatePair(pair: Pair, comment: string): void {
  if (isScalar(pair.value)) {
    pair.value.comment = comment;
  } else if (isNode(pair.key)) {
    pair.key.comment = comment;
  }
}

function formatSource(origin: SourceOrigin): string {
  const self = `${basename(origin.file)}:${origin.line}`;
  if (origin.overrides === undefined) return ` ${self}`;
  const prev = `${basename(origin.overrides.file)}:${origin.overrides.line}`;
  return ` ${self} (overrides ${prev})`;
}

function count(value: number, label: string): string {
  return `${value} ${label}`;
}
