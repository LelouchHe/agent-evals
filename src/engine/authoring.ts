import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ZodType } from "zod";
import { parseImplementationParams } from "./params.ts";
import { checkPlaceholders, substituteValues, type ValueSource } from "./values.ts";
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";
import {
  CASES_KEY,
  CASE_FIELDS,
  CASE_FIELD_KEYS,
  ConfigError,
  errorMessage,
  expectCaseConfig,
  type CaseConfig,
  type FieldOrigin,
  type FieldType,
  type ResolvedCase,
  type SourceOrigin,
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
  const document = await readCaseDocument(path);
  return buildCase(document, selectCase(document.cases, selection.caseName, document.file));
}

/**
 * Resolve every selected case in declaration order: the named one when a name is
 * given, all entries of a `cases` document when it is not, or the one ordinary case.
 */
export async function loadCases(path: string, selection: CaseSelection = {}): Promise<readonly ResolvedCase[]> {
  const document = await readCaseDocument(path);
  const { cases, file } = document;
  if (cases === undefined) {
    return [buildCase(document, selectCase(undefined, selection.caseName, file))];
  }
  if (selection.caseName !== undefined) {
    return [buildCase(document, selectCase(cases, selection.caseName, file))];
  }
  return [...cases.values()].map((entry) => buildCase(document, entry));
}

interface CaseDocument {
  readonly file: string;
  readonly text: string;
  readonly common: readonly FieldEntry[];
  readonly cases?: ReadonlyMap<string, CaseEntry>;
}

async function readCaseDocument(path: string): Promise<CaseDocument> {
  const { file, text, fields } = await readMapping(path);
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
  return { file, text, common, ...(cases === undefined ? {} : { cases }) };
}

function buildCase(document: CaseDocument, selected: CaseEntry | undefined): ResolvedCase {
  const { file, text, common } = document;
  const final: Record<string, unknown> = {};
  const origins: Record<string, FieldOrigin> = {};
  for (const field of common) {
    const type = fieldType(field.key);
    final[field.key] = fieldValue(field);
    origins[field.key] = extractFieldOrigin(type, field, { file, line: field.line, kind: "common" }, text);
  }
  if (selected !== undefined) {
    for (const field of selected.fields) {
      const type = fieldType(field.key);
      const nextValue = fieldValue(field);
      const nextOrigin = extractFieldOrigin(
        type,
        field,
        { file, line: field.line, kind: "case", caseName: selected.name },
        text,
      );
      if (Object.hasOwn(final, field.key)) {
        final[field.key] = composeFieldValue(type, field.key, final[field.key], nextValue, selected.name, file);
        origins[field.key] = composeFieldOrigin(type, origins[field.key]!, nextOrigin);
      } else {
        final[field.key] = nextValue;
        origins[field.key] = nextOrigin;
      }
    }
  }

  const label = selected === undefined ? `case configuration ${file}` : `case "${selected.name}"`;
  const config = expectCaseConfig(final, label);
  for (const [index, record] of [config.runner, ...config.checks].entries()) {
    const { $type: _, ...params } = record;
    checkPlaceholders(params, index === 0 ? `${label} runner` : `${label} checks[${index - 1}]`);
  }

  return {
    path: file,
    dir: dirname(file),
    ...(selected === undefined ? {} : { name: selected.name }),
    config,
    origins,
  };
}

function fieldType(key: string): FieldType {
  return CASE_FIELDS[key as keyof CaseConfig];
}

function composeFieldValue(
  type: FieldType,
  key: string,
  commonValue: unknown,
  caseValue: unknown,
  caseName: string,
  file: string,
): unknown {
  if (typeof type !== "string") {
    if (!isPlainRecord(commonValue) || !isPlainRecord(caseValue)) {
      return isPlainRecord(commonValue) ? caseValue : commonValue;
    }
    const merged: Record<string, unknown> = { ...commonValue };
    for (const [group, caseGroup] of Object.entries(caseValue)) {
      merged[group] = Object.hasOwn(merged, group)
        ? composeFieldValue(type.child, `${key}.${group}`, merged[group], caseGroup, caseName, file)
        : caseGroup;
    }
    return merged;
  }
  switch (type) {
    case "value":
      return caseValue;
    case "list":
      if (!Array.isArray(commonValue) || !Array.isArray(caseValue)) {
        return Array.isArray(commonValue) ? caseValue : commonValue;
      }
      return [...commonValue, ...caseValue];
    case "map":
      return mergeDisjointMap(commonValue, caseValue, key, caseName, file);
  }
}

function mergeDisjointMap(
  commonMap: unknown,
  caseMap: unknown,
  label: string,
  caseName: string,
  file: string,
): unknown {
  if (!isPlainRecord(commonMap) || !isPlainRecord(caseMap)) {
    return isPlainRecord(commonMap) ? caseMap : commonMap;
  }
  const duplicates = Object.keys(caseMap).filter((entry) => Object.hasOwn(commonMap, entry));
  if (duplicates.length > 0) {
    throw new ConfigError(
      `case "${caseName}" in ${file} repeats ${label} ${duplicates.length === 1 ? "entry" : "entries"} from the common part: ${duplicates.join(", ")}; common and case entries must be disjoint`,
    );
  }
  return { ...commonMap, ...caseMap };
}

function extractFieldOrigin(
  type: FieldType,
  field: { readonly node: unknown },
  base: SourceOrigin,
  text: string,
): FieldOrigin {
  if (typeof type !== "string") {
    if (!isMap(field.node)) return base;
    const entries: Record<string, FieldOrigin> = {};
    for (const pair of field.node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
      const entryBase: SourceOrigin = {
        ...base,
        line: isNode(pair.key) ? lineAt(pair.key, text) : base.line,
      };
      entries[pair.key.value] = extractFieldOrigin(type.child, { node: pair.value }, entryBase, text);
    }
    return { kind: "group", entries };
  }
  switch (type) {
    case "value":
      return base;
    case "list": {
      if (!isSeq(field.node)) return base;
      const items = field.node.items.map((item) => ({
        ...base,
        line: isNode(item) ? lineAt(item, text) : base.line,
      }));
      return { kind: "list", items };
    }
    case "map": {
      if (!isMap(field.node)) return base;
      return { kind: "map", entries: mapEntryOrigins(field.node, base, text) };
    }
  }
}

function mapEntryOrigins(node: YAMLMap, base: SourceOrigin, text: string): Readonly<Record<string, SourceOrigin>> {
  const entries: Record<string, SourceOrigin> = {};
  for (const pair of node.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    entries[pair.key.value] = {
      ...base,
      line: isNode(pair.key) ? lineAt(pair.key, text) : base.line,
    };
  }
  return entries;
}

function composeFieldOrigin(type: FieldType, common: FieldOrigin, next: FieldOrigin): FieldOrigin {
  if (typeof type !== "string") {
    if (common.kind === "group" && next.kind === "group") {
      const entries: Record<string, FieldOrigin> = { ...common.entries };
      for (const [group, entryOrigin] of Object.entries(next.entries)) {
        entries[group] = Object.hasOwn(entries, group)
          ? composeFieldOrigin(type.child, entries[group]!, entryOrigin)
          : entryOrigin;
      }
      return { kind: "group", entries };
    }
    return next;
  }
  switch (type) {
    case "value":
      return next;
    case "list":
      if (common.kind === "list" && next.kind === "list") {
        return { kind: "list", items: [...common.items, ...next.items] };
      }
      return next;
    case "map":
      if (common.kind === "map" && next.kind === "map") {
        return { kind: "map", entries: { ...common.entries, ...next.entries } };
      }
      return next;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load a standalone implementation object using the same YAML and placeholder rules as cases. */
export async function loadImplementationParameters<P>(
  path: string,
  schema: ZodType<P>,
  source: ValueSource,
): Promise<{ params: P; dir: string }> {
  const { file, fields } = await readMapping(path);
  // Preserve every YAML key as data, including __proto__, for schema validation.
  const raw: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field.key, fieldValue(field)]));
  return {
    params: await parseImplementationParams(schema, await substituteValues(raw, file, source), file),
    dir: dirname(file),
  };
}

async function readMapping(path: string): Promise<{ file: string; text: string; fields: FieldEntry[] }> {
  const file = resolve(path);
  const text = await readConfiguration(file);
  const document = parseDocument(text, { merge: false, uniqueKeys: true });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue !== undefined) {
    const kind = document.errors.length > 0 ? "invalid" : "unsupported";
    throw new ConfigError(`${kind} YAML in configuration ${file}: ${issue.message}`);
  }
  if (document.contents === null || document.contents === undefined) {
    throw new ConfigError(`configuration ${file} must contain a YAML mapping`);
  }
  rejectForbiddenSyntax(document.contents, text, file);
  const root = expectMapNode(document.contents, "configuration", file);
  return { file, text, fields: readFields(root, "configuration", file, text) };
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
