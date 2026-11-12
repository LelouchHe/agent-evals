import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";
import {
  CASES_KEY,
  CASE_FIELD_KEYS,
  ConfigError,
  errorMessage,
  expectCaseConfig,
  type FieldOrigin,
  type ResolvedCase,
} from "./config.ts";

export interface CaseSelection {
  /** The named case to select. Required when the document defines `cases`. */
  readonly caseName?: string;
}

interface FieldEntry {
  readonly key: string;
  readonly node: unknown;
  /** 1-based line of the field declaration. */
  readonly line: number;
}

interface CaseEntry {
  readonly name: string;
  readonly fields: readonly FieldEntry[];
}

/**
 * Resolve one YAML authoring document to a single case.
 *
 * `view` and execution both use this function, so they see the same values and
 * field origins. Runtime implementation validation remains a separate step.
 */
export async function loadCase(path: string, selection: CaseSelection = {}): Promise<ResolvedCase> {
  const file = resolve(path);
  const text = await readConfiguration(file);
  const document = parseDocument(text, { merge: false, uniqueKeys: true });
  const firstError = document.errors[0];
  if (firstError !== undefined) {
    throw new ConfigError(`invalid YAML in case configuration ${file}: ${firstError.message}`);
  }
  const firstWarning = document.warnings[0];
  if (firstWarning !== undefined) {
    throw new ConfigError(`unsupported YAML in case configuration ${file}: ${firstWarning.message}`);
  }
  if (document.contents === null || document.contents === undefined) {
    throw new ConfigError(`case configuration ${file} must contain a YAML mapping`);
  }

  rejectForbiddenSyntax(document.contents, text, file);
  const root = expectMapNode(document.contents, "case configuration", file);
  const fields = readFields(root, "case configuration", file, text);

  const common: FieldEntry[] = [];
  let casesField: FieldEntry | undefined;
  for (const field of fields) {
    if (field.key === CASES_KEY) {
      casesField = field;
      continue;
    }
    if (!CASE_FIELD_KEYS.has(field.key)) {
      throw new ConfigError(`case configuration ${file} has unknown field: ${field.key}`);
    }
    common.push(field);
  }

  const cases = casesField === undefined ? undefined : parseCases(casesField, file, text);
  const selected = selectCase(cases, selection.caseName, file);
  if (selected !== undefined) {
    const commonKeys = new Set(common.map((field) => field.key));
    const shared = selected.fields.filter((field) => commonKeys.has(field.key)).map((field) => field.key);
    if (shared.length > 0) {
      throw new ConfigError(
        `case "${selected.name}" in ${file} repeats top-level field${shared.length === 1 ? "" : "s"} from the common part: ${shared.join(", ")}; common and selected fields must be disjoint`,
      );
    }
  }

  const final: Record<string, unknown> = {};
  const origins: Record<string, FieldOrigin> = {};
  for (const field of common) {
    final[field.key] = fieldValue(field);
    origins[field.key] = { file, line: field.line, kind: "common" };
  }
  if (selected !== undefined) {
    for (const field of selected.fields) {
      final[field.key] = fieldValue(field);
      origins[field.key] = { file, line: field.line, kind: "case", caseName: selected.name };
    }
  }

  const label = selected === undefined ? `case configuration ${file}` : `case "${selected.name}"`;
  const config = expectCaseConfig(final, label);

  return {
    path: file,
    dir: dirname(file),
    ...(selected === undefined ? {} : { name: selected.name }),
    config,
    origins,
  };
}

async function readConfiguration(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new ConfigError(`could not read case configuration ${file}: ${errorMessage(error)}`);
  }
}

function parseCases(field: FieldEntry, file: string, text: string): Map<string, CaseEntry> {
  const node = expectMapNode(field.node, "cases", file);
  if (node.items.length === 0) {
    throw new ConfigError(`case configuration ${file} has an empty cases mapping; add a named case or omit cases`);
  }

  const cases = new Map<string, CaseEntry>();
  for (const pair of node.items) {
    const name = fieldKey(pair, "cases entry", file);
    if (name.trim().length === 0) {
      throw new ConfigError(`case configuration ${file} has an empty case name`);
    }
    if (cases.has(name)) {
      throw new ConfigError(`case configuration ${file} repeats case name "${name}"`);
    }
    const entryNode = expectMapNode(pair.value, `case "${name}"`, file);
    const fields = readFields(entryNode, `case "${name}"`, file, text);
    for (const entryField of fields) {
      if (entryField.key === CASES_KEY) {
        throw new ConfigError(
          `case "${name}" in ${file} contains nested cases; cases may only appear at the document root`,
        );
      }
      if (!CASE_FIELD_KEYS.has(entryField.key)) {
        throw new ConfigError(`case "${name}" in ${file} has unknown field: ${entryField.key}`);
      }
    }
    cases.set(name, { name, fields });
  }
  return cases;
}

function selectCase(
  cases: ReadonlyMap<string, CaseEntry> | undefined,
  caseName: string | undefined,
  file: string,
): CaseEntry | undefined {
  if (cases === undefined) {
    if (caseName !== undefined) {
      throw new ConfigError(`case configuration ${file} does not define named cases; omit the case selection`);
    }
    return undefined;
  }

  const names = [...cases.keys()].join(", ");
  if (caseName === undefined || caseName.trim().length === 0) {
    throw new ConfigError(`case configuration ${file} defines named cases (${names}); select one with --case <name>`);
  }
  const selected = cases.get(caseName);
  if (selected === undefined) {
    throw new ConfigError(`case configuration ${file} has no case named "${caseName}" (available: ${names})`);
  }
  return selected;
}

function readFields(node: YAMLMap, label: string, file: string, text: string): FieldEntry[] {
  const fields: FieldEntry[] = [];
  const seen = new Set<string>();
  for (const pair of node.items) {
    const key = fieldKey(pair, `${label} field`, file);
    if (seen.has(key)) {
      throw new ConfigError(`${label} in ${file} repeats field "${key}"`);
    }
    seen.add(key);
    const keyNode = pair.key;
    fields.push({
      key,
      node: pair.value,
      line: isNode(keyNode) ? lineAt(keyNode, text) : 1,
    });
  }
  return fields;
}

function fieldKey(pair: Pair, label: string, file: string): string {
  if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
    throw new ConfigError(`${label} in ${file} must use a string key`);
  }
  return pair.key.value;
}

function fieldValue(field: FieldEntry): unknown {
  if (field.node === null || field.node === undefined) {
    return null;
  }
  return isNode(field.node) ? field.node.toJSON() : field.node;
}

function expectMapNode(node: unknown, label: string, file: string): YAMLMap {
  if (!isMap(node)) {
    throw new ConfigError(`${label} in ${file} must be a YAML mapping`);
  }
  return node;
}

/**
 * Reject syntax that this authoring format does not support. The visitor
 * inspects parsed nodes, so ordinary text values that merely look like YAML
 * reuse syntax remain valid data.
 */
function rejectForbiddenSyntax(node: unknown, text: string, file: string): void {
  rejectAliases(node, text, file);
  rejectUnsupportedSyntax(node, text, file);
}

function rejectAliases(node: unknown, text: string, file: string): void {
  if (isAlias(node)) {
    throw new ConfigError(`YAML aliases are not supported in case configuration ${file} (line ${lineAt(node, text)})`);
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      rejectAliases(pair.key, text, file);
      rejectAliases(pair.value, text, file);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      rejectAliases(item, text, file);
    }
  }
}

function rejectUnsupportedSyntax(node: unknown, text: string, file: string): void {
  if (isScalar(node)) {
    rejectAnchor(node, text, file);
    return;
  }
  if (isMap(node)) {
    rejectAnchor(node, text, file);
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        throw new ConfigError(
          `reserved YAML key "<<" is not supported in case configuration ${file} (line ${lineAt(pair.key, text)})`,
        );
      }
      rejectUnsupportedSyntax(pair.key, text, file);
      rejectUnsupportedSyntax(pair.value, text, file);
    }
    return;
  }
  if (isSeq(node)) {
    rejectAnchor(node, text, file);
    for (const item of node.items) {
      rejectUnsupportedSyntax(item, text, file);
    }
  }
}

function rejectAnchor(node: Node, text: string, file: string): void {
  if (node.anchor !== undefined) {
    throw new ConfigError(`YAML anchors are not supported in case configuration ${file} (line ${lineAt(node, text)})`);
  }
}

function lineAt(node: Node, text: string): number {
  const offset = node.range?.[0] ?? 0;
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}
