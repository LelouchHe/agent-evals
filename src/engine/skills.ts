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

/** The run directories the derivation reads: the workspace a trace names, and its initial snapshot. */
export interface SkillSources {
  /** The workspace as the agent left it; absolute trace paths are resolved against it. */
  readonly workspace: RunRoot;
  /** The workspace's initial snapshot, where a placed skill's frontmatter is read. */
  readonly baseline: RunRoot;
}

/**
 * The skills one run consulted, derived from its trace and the run's workspace and baseline.
 *
 * ACP has no skill update, so this reads the two forms harnesses report: a completed
 * non-read tool call carrying `rawInput.skill` (Claude Code, GitHub Copilot CLI), and a
 * completed `read` of a `SKILL.md` (Pi). Only completed tool calls count, and a skill is
 * one consultation however many times or chunks it was read.
 *
 * The baseline is each run's initial workspace snapshot, so a skill placed in the
 * workspace is named from its frontmatter there. A read outside the workspace is named
 * from the text it returned, then from the skill's parent directory.
 */
export async function skillConsultations(
  trace: readonly TraceEntry[],
  sources: SkillSources,
): Promise<readonly SkillConsultation[]> {
  const consultations = new Map<string, SkillConsultation>();
  for (const entry of trace) {
    if (entry.type !== "tool" || entry.status !== "completed") continue;
    const consultation = await recognize(entry, sources);
    if (consultation !== undefined && !consultations.has(consultation.name)) {
      consultations.set(consultation.name, consultation);
    }
  }
  return [...consultations.values()];
}

async function recognize(entry: ToolEntry, sources: SkillSources): Promise<SkillConsultation | undefined> {
  // A dedicated skill tool reports the name directly.
  if (entry.kind !== "read") {
    const name = stringField(entry.rawInput, "skill");
    return name === undefined ? undefined : { name, fromDirectory: false };
  }

  // A skill loader that reads the body has to name the SKILL.md it read.
  const target = readTarget(entry);
  if (target === undefined) return undefined;

  const fromBaseline = await baselineName(sources, target);
  if (fromBaseline !== undefined) return { name: fromBaseline, fromDirectory: false };

  const fromOutput = frontmatterName(returnedText(entry));
  if (fromOutput !== undefined) return { name: fromOutput, fromDirectory: false };

  const directory = basename(dirname(target));
  if (directory === "" || directory === "." || directory === "/") return undefined;
  return { name: directory, fromDirectory: true };
}

/** The path a completed read targeted, when it names a skill file. */
function readTarget(entry: ToolEntry): string | undefined {
  const locations = Array.isArray(entry.locations) ? entry.locations : [];
  const location = locations[0] as { readonly path?: unknown } | undefined;
  const path =
    stringField(location, "path") ?? stringField(entry.rawInput, "path") ?? stringField(entry.rawInput, "file_path");
  return path !== undefined && basename(path) === SKILL_FILE ? path : undefined;
}

/** The frontmatter name of the same file in the baseline, when the read target is in the workspace. */
async function baselineName(sources: SkillSources, target: string): Promise<string | undefined> {
  const path = isAbsolute(target) ? await relativeWithinWorkspace(sources.workspace.path, target) : target;
  if (path === undefined) return undefined;
  try {
    return frontmatterName((await readRunFile(sources.baseline, path)).toString("utf8"));
  } catch {
    // A path outside the snapshot, unreadable, or not a regular file names nothing here;
    // the returned text and the parent directory remain.
    return undefined;
  }
}

/**
 * Strip the outermost workspace root prefix from an absolute trace path (`/var/…` vs
 * `/private/var/…`, or a symlinked temp root) without following agent-writable symlinks inside
 * the live workspace. Walking from `/` downward finds the host's workspace root before entering
 * any workspace child.
 */
async function relativeWithinWorkspace(workspacePath: string, target: string): Promise<string | undefined> {
  const segments = resolve(target).split("/").filter(Boolean);
  let probe = "/";
  for (const [index, segment] of segments.entries()) {
    probe = join(probe, segment);
    const rest = segments.slice(index + 1);
    if (probe === workspacePath) {
      return rest.length === 0 ? undefined : join(...rest);
    }
    try {
      if ((await realpath(probe)) === workspacePath) {
        return rest.length === 0 ? undefined : join(...rest);
      }
    } catch {
      // An unreadable or missing prefix outside the workspace means this path cannot enter it.
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
  return stringField(frontmatter, "name");
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string") return undefined;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
