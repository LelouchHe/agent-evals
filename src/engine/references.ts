import { ConfigError, type EnvReference, type ImplementationParams } from "./config.ts";
import type { EnvSource } from "./env-source.ts";

/** Expand only references recorded from unquoted YAML nodes, once per implementation. */
export async function expandReferences(
  params: ImplementationParams,
  references: readonly EnvReference[],
  prefix: readonly (string | number)[],
  source: EnvSource,
): Promise<ImplementationParams> {
  const selected = references.filter((reference) => prefix.every((part, index) => reference.path[index] === part));
  if (selected.length === 0) return params;
  const expanded = structuredClone(params);
  for (const reference of selected) {
    setAtPath(expanded, reference.path.slice(prefix.length), await source.require(reference.name));
  }
  return expanded;
}

function setAtPath(root: Record<string, unknown>, path: readonly (string | number)[], value: string): void {
  let current: Record<string, unknown> | unknown[] = root;
  for (const [index, part] of path.entries()) {
    if (index === path.length - 1) {
      (current as Record<string | number, unknown>)[part] = value;
      return;
    }
    const next = (current as Record<string | number, unknown>)[part];
    if (typeof next !== "object" || next === null) {
      throw new ConfigError(`cannot resolve environment reference at ${path.map(String).join(".")}`);
    }
    current = next as Record<string, unknown> | unknown[];
  }
}
