import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import type { TraceEntry } from "./registry.ts";
import { readRunFile, type RunRoot } from "./workspace.ts";

/** The file every harness's skill loader reads when it consults a skill's body. */
const SKILL_FILE = "SKILL.md";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type ToolEntry = Extract<TraceEntry, { type: "tool" }>;

/** One skill a run consulted, as far as its trace and workspace show. */
export interface SkillConsultation {
  /** The skill's frontmatter `name`, or the parent directory's when no source gives a frontmatter name. */
  readonly name: string;
  /** True when `name` is the parent directory's, because neither the baseline nor the output named it. */
  readonly fromDirectory: boolean;
}

/**
 * The run directories the derivation reads: the live workspace and HOME a trace names, and what
 * the case placed in each before the agent started.
 */
export interface SkillSources {
  /** The workspace as the agent left it; relative trace paths are resolved against it. */
  readonly workspace: RunRoot;
  /** The run HOME as the agent left it; `~/` and absolute paths inside it resolve here. */
  readonly home: RunRoot;
  /** The workspace's initial snapshot, where a placed skill's frontmatter is read. */
  readonly workspaceBaseline: RunRoot;
  /** What the case placed in HOME; agent-file and login content is not part of it. */
  readonly homeBaseline: RunRoot;
}

/**
 * The skills one run consulted, derived from its trace and the run's workspace and baseline.
 *
 * ACP has no skill update, so this reads the two forms harnesses report: a completed
 * non-read tool call carrying `rawInput.skill` (Claude Code, GitHub Copilot CLI), and a
 * completed `read` of a `SKILL.md` (Pi). Only completed tool calls count, and a skill is
 * one consultation however many times or chunks it was read.
 *
 * A skill the case placed, in the workspace or in HOME, is named from its frontmatter in that
 * root's baseline. A read outside both roots is named from the text it returned, then from the
 * skill's parent directory.
 */
export async function skillConsultations(
  trace: readonly TraceEntry[],
  sources: SkillSources,
): Promise<readonly SkillConsultation[]> {
  const recognized: ({ readonly key?: string } & SkillConsultation)[] = [];
  const frontmatterTargets = new Set<string>();
  for (const entry of trace) {
    if (entry.type !== "tool" || entry.status !== "completed") continue;
    if (entry.kind !== "read") {
      const name = trimmedField(entry.rawInput, "skill");
      if (name !== undefined) recognized.push({ name, fromDirectory: false });
      continue;
    }
    const read = await recognizeRead(entry, sources);
    if (read === undefined) continue;
    if (!read.consultation.fromDirectory) frontmatterTargets.add(read.key);
    recognized.push({ key: read.key, ...read.consultation });
  }

  const consultations = new Map<string, SkillConsultation>();
  for (const item of recognized) {
    // A chunk without frontmatter on a file another chunk already named from frontmatter adds nothing.
    if (item.fromDirectory && item.key !== undefined && frontmatterTargets.has(item.key)) continue;
    const consultation: SkillConsultation = { name: item.name, fromDirectory: item.fromDirectory };
    const existing = consultations.get(consultation.name);
    if (existing === undefined || (existing.fromDirectory && !consultation.fromDirectory)) {
      consultations.set(consultation.name, consultation);
    }
  }
  return [...consultations.values()];
}

/** A skill whose placed `SKILL.md` an executed command's text named, reported but never counted. */
export interface ShellSkillAccess {
  /** The skill's frontmatter `name` in the baseline, or its parent directory's. */
  readonly name: string;
}

/**
 * The placed skills whose `SKILL.md` path an executed command's text named.
 *
 * Whether reading a skill body through a shell is a consultation is ambiguous, so this is
 * reported separately and never counts as one. Only a `SKILL.md` a baseline placed is
 * recognized; a file the agent created is not the skill it started with.
 */
export async function shellSkillAccess(
  trace: readonly TraceEntry[],
  sources: SkillSources,
): Promise<readonly ShellSkillAccess[]> {
  const found = new Map<string, ShellSkillAccess>();
  for (const entry of trace) {
    if (entry.type !== "tool" || entry.status !== "completed" || entry.kind !== "execute") continue;
    const command = pathField(entry.rawInput, "command");
    if (command === undefined) continue;
    for (const token of commandSkillPaths(command)) {
      const name = await placedSkillName(token, sources);
      if (name !== undefined && !found.has(name)) found.set(name, { name });
    }
  }
  return [...found.values()];
}

/** Path-shaped tokens of a command whose basename is `SKILL.md`, in command order. */
function commandSkillPaths(command: string): string[] {
  return command.split(/[\s;|&()<>'"`]+/).filter((token) => token.length > 0 && basename(token) === SKILL_FILE);
}

/** The skill a workspace path names, when the baseline placed a `SKILL.md` there. */
async function placedSkillName(target: string, sources: SkillSources): Promise<string | undefined> {
  const resolved = await resolveTarget(sources, target);
  if (resolved.placed === undefined) return undefined;
  let text: string;
  try {
    text = (await readRunFile(resolved.placed.baseline, resolved.placed.relativePath)).toString("utf8");
  } catch {
    // Not placed by the baseline, unreadable, or not a regular file.
    return undefined;
  }
  const name = frontmatterName(text);
  if (name !== undefined) return name;
  const directory = basename(dirname(target));
  return directory === "" || directory === "." || directory === "/" ? undefined : directory;
}

async function recognizeRead(
  entry: ToolEntry,
  sources: SkillSources,
): Promise<{ readonly key: string; readonly consultation: SkillConsultation } | undefined> {
  // A skill loader that reads the body has to name the SKILL.md it read.
  const target = readTarget(entry);
  if (target === undefined) return undefined;

  const resolved = await resolveTarget(sources, target);
  if (resolved.placed !== undefined) {
    const fromBaseline = await baselineName(resolved.placed.baseline, resolved.placed.relativePath);
    if (fromBaseline !== undefined) {
      return { key: resolved.key, consultation: { name: fromBaseline, fromDirectory: false } };
    }
  }

  const fromOutput = frontmatterName(returnedText(entry));
  if (fromOutput !== undefined) return { key: resolved.key, consultation: { name: fromOutput, fromDirectory: false } };

  const directory = basename(dirname(target));
  if (directory === "" || directory === "." || directory === "/") return undefined;
  return { key: resolved.key, consultation: { name: directory, fromDirectory: true } };
}

/** The path a completed read targeted, when it names a skill file. */
function readTarget(entry: ToolEntry): string | undefined {
  const locations = Array.isArray(entry.locations) ? entry.locations : [];
  const location = locations[0] as { readonly path?: unknown } | undefined;
  const path =
    pathField(location, "path") ?? pathField(entry.rawInput, "path") ?? pathField(entry.rawInput, "file_path");
  if (path === undefined || path.endsWith("/") || path.endsWith("\\")) return undefined;
  return basename(path) === SKILL_FILE ? path : undefined;
}

/** The frontmatter name of the same file in the baseline. */
async function baselineName(baseline: RunRoot, path: string): Promise<string | undefined> {
  try {
    return frontmatterName((await readRunFile(baseline, path)).toString("utf8"));
  } catch {
    // A path outside the snapshot, unreadable, or not a regular file names nothing here;
    // the returned text and the parent directory remain.
    return undefined;
  }
}

/** A resolved read target: its identity, and where it is placed when a run root holds it. */
interface ResolvedTarget {
  readonly key: string;
  readonly placed?: { readonly relativePath: string; readonly baseline: RunRoot };
}

/**
 * Resolve a read target to a stable identity and, when it names a run root, the path inside it
 * and the baseline that recorded the case's placement there. Never follows agent-writable
 * symlinks inside a live root.
 */
async function resolveTarget(sources: SkillSources, target: string): Promise<ResolvedTarget> {
  if (target.startsWith("~/")) {
    const fullPath = resolve(sources.home.path, target.slice(2));
    const relativePath = await relativeWithin(sources.home.path, fullPath);
    return relativePath === undefined
      ? { key: `outside:${await canonicalExternalPath(fullPath)}` }
      : { key: `home:${relativePath}`, placed: { relativePath, baseline: sources.homeBaseline } };
  }
  const fullPath = isAbsolute(target) ? target : resolve(sources.workspace.path, target);
  const workspacePath = await relativeWithin(sources.workspace.path, fullPath);
  if (workspacePath !== undefined) {
    return {
      key: `workspace:${workspacePath}`,
      placed: { relativePath: workspacePath, baseline: sources.workspaceBaseline },
    };
  }
  const homePath = await relativeWithin(sources.home.path, fullPath);
  if (homePath !== undefined) {
    return { key: `home:${homePath}`, placed: { relativePath: homePath, baseline: sources.homeBaseline } };
  }
  return { key: `outside:${await canonicalExternalPath(fullPath)}` };
}

/** Canonicalize existing ancestors of an external path so `/var/…` and `/private/var/…` match. */
async function canonicalExternalPath(target: string): Promise<string> {
  const missing: string[] = [];
  let probe = resolve(target);
  while (true) {
    try {
      return join(await realpath(probe), ...missing);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return resolve(target);
      missing.unshift(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Strip the outermost run-root prefix from an absolute trace path (`/var/…` vs `/private/var/…`,
 * or a symlinked temp root) without following agent-writable symlinks inside the live root.
 * Walking from `/` downward finds the host's root before entering any of its children.
 */
async function relativeWithin(rootPath: string, target: string): Promise<string | undefined> {
  const segments = resolve(target).split("/").filter(Boolean);
  let probe = "/";
  for (const [index, segment] of segments.entries()) {
    probe = join(probe, segment);
    const rest = segments.slice(index + 1);
    if (probe === rootPath) {
      return rest.length === 0 ? undefined : join(...rest);
    }
    try {
      if ((await realpath(probe)) === rootPath) {
        return rest.length === 0 ? undefined : join(...rest);
      }
    } catch {
      // An unreadable or missing prefix outside the root means this path cannot enter it.
      return undefined;
    }
  }
  return undefined;
}

/** The text a call returned, from its content blocks or otherwise its raw output. */
function returnedText(entry: ToolEntry): string | undefined {
  const texts = textBlocks(entry.content);
  if (texts.length > 0) return texts.join("\n");
  if (typeof entry.rawOutput === "string") return entry.rawOutput;
  const raw = textBlocks(entry.rawOutput);
  return raw.length === 0 ? undefined : raw.join("\n");
}

/** Text of plain text blocks, or of `{ type: "content", content: { type: "text" } }` blocks. */
function textBlocks(value: unknown): string[] {
  const container = typeof value === "object" && value !== null ? (value as { readonly content?: unknown }) : undefined;
  const blocks = Array.isArray(value)
    ? value
    : Array.isArray(container?.content)
      ? (container.content as unknown[])
      : [value];
  return blocks.flatMap((block) => {
    if (typeof block === "string") return [block];
    if (typeof block !== "object" || block === null) return [];
    const item = block as {
      readonly type?: unknown;
      readonly text?: unknown;
      readonly content?: { readonly type?: unknown; readonly text?: unknown };
    };
    if (item.type === "text" && typeof item.text === "string") return [item.text];
    if (item.content?.type === "text" && typeof item.content.text === "string") return [item.content.text];
    return [];
  });
}

/** The `name` a Markdown frontmatter block declares, if it declares a non-empty one. */
function frontmatterName(text: string | undefined): string | undefined {
  const block = text === undefined ? undefined : FRONTMATTER.exec(text)?.[1];
  if (block === undefined) return undefined;
  let frontmatter: unknown;
  try {
    frontmatter = parse(block);
  } catch {
    return undefined;
  }
  if (typeof frontmatter !== "object" || frontmatter === null) return undefined;
  return trimmedField(frontmatter, "name");
}

/** Read a path field verbatim without trimming legal leading or trailing filename spaces. */
function pathField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function trimmedField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string") return undefined;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
