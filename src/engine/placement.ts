import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ConfigError, errorMessage, resolveAuthoringAsset, workspaceTargetPath, type ResolvedCase } from "./config.ts";
import { homeEntries, isHomeDestination, workspaceEntries } from "./files.ts";
import { ignoreDecision, IgnoreTree, IGNORE_FILE_NAME } from "./ignore.ts";
import type { IgnoreDecision } from "./ignore.ts";
import { isMissing } from "./workspace.ts";

/** One placed file: its destination and the authoring source it came from. */
export interface PlacedPath {
  readonly path: string;
  readonly source: string;
}

/** One excluded path: what the ignore file removed, and which file decided it. */
export interface ExcludedPath {
  readonly path: string;
  readonly directory: boolean;
  /** The directory holding the deciding `.agentevalsignore`, relative to the case file. */
  readonly ignoreDir: string;
}

/** What one case-level entry places, without running anything. */
export interface PlacementSummary {
  /** The declaration this entry comes from, such as `files ".agents/skills"` or `home "~/notes"`. */
  readonly label: string;
  readonly placed: readonly PlacedPath[];
  readonly excluded: readonly ExcludedPath[];
}

/**
 * Describe what the case's `fixture` and `files` entries would place, using the same traversal
 * and ignore rules as the run. Only the case is described: the agent file's HOME content is the
 * runner's, and check-time `files` are not part of the initial environment.
 */
export async function describePlacement(loadedCase: ResolvedCase): Promise<readonly PlacementSummary[]> {
  const summaries: PlacementSummary[] = [];
  const fixture = loadedCase.config.fixture;
  if (fixture !== undefined) {
    summaries.push(
      await describeEntry(loadedCase, {
        label: `fixture ${fixture}`,
        source: fixture,
        pathPrefix: "",
        sourceDisplay: fixture,
      }),
    );
  }
  for (const entry of [...workspaceEntries(loadedCase.config.files), ...homeEntries(loadedCase.config.files)]) {
    const home = isHomeDestination(entry.destination);
    const target = home ? join("~", entry.target) : entry.target;
    summaries.push(
      await describeEntry(loadedCase, {
        label: `${home ? "home" : "files"} ${JSON.stringify(entry.destination)}`,
        source: entry.source,
        pathPrefix: target,
        sourceDisplay: entry.source,
      }),
    );
  }
  return summaries;
}

interface DescriptionRequest {
  readonly label: string;
  /** The authoring source, relative to the case file. */
  readonly source: string;
  /** What each placed path is prefixed with in the report; empty for the fixture. */
  readonly pathPrefix: string;
  /** How the source itself is shown in a `place` line. */
  readonly sourceDisplay: string;
}

async function describeEntry(loadedCase: ResolvedCase, request: DescriptionRequest): Promise<PlacementSummary> {
  const root = resolveAuthoringAsset(loadedCase.dir, request.source, request.label);
  const placed: PlacedPath[] = [];
  const excluded: ExcludedPath[] = [];
  await describePath(root, root, [], request, loadedCase.dir, placed, excluded, new IgnoreTree());
  return { label: request.label, placed, excluded };
}

async function describePath(
  source: string,
  root: string,
  segments: readonly string[],
  request: DescriptionRequest,
  caseDir: string,
  placed: PlacedPath[],
  excluded: ExcludedPath[],
  tree: IgnoreTree,
): Promise<void> {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    throw new ConfigError(`${request.label} source ${request.source} is not accessible: ${errorMessage(error)}`);
  }
  let kind: "file" | "directory" | "other";
  if (info.isSymbolicLink()) {
    let target;
    try {
      target = await stat(source);
    } catch (error) {
      throw new ConfigError(`${request.label} source ${request.source} is not accessible: ${errorMessage(error)}`);
    }
    kind = target.isFile() ? "file" : "other";
  } else {
    kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  }

  if (segments.length > 0) {
    const decision: IgnoreDecision = await ignoreDecision(tree, root, segments, kind === "directory");
    if (decision.ignored) {
      // The declaration file itself is not content and is not reported.
      if (segments[segments.length - 1] !== IGNORE_FILE_NAME) {
        excluded.push({
          path: destinationOf(request, segments),
          directory: kind === "directory",
          ignoreDir: relative(caseDir, dirname(decision.file ?? "")),
        });
      }
      return;
    }
  }
  if (kind === "other") {
    // The copy rejects a special file; the report names it rather than silently dropping it.
    placed.push({ path: destinationOf(request, segments), source: sourceOf(request, segments) });
    return;
  }
  if (kind === "file") {
    placed.push({ path: destinationOf(request, segments), source: sourceOf(request, segments) });
    return;
  }
  let names: string[];
  try {
    names = await readdir(source);
  } catch (error) {
    if (isMissing(error)) throw new ConfigError(`${request.label} source ${request.source} is not accessible`);
    throw error;
  }
  for (const name of [...names].sort()) {
    await describePath(join(source, name), root, [...segments, name], request, caseDir, placed, excluded, tree);
  }
}

function destinationOf(request: DescriptionRequest, segments: readonly string[]): string {
  const relativePath = segments.join("/");
  const prefix = workspaceTargetPath(request.pathPrefix);
  return prefix.length === 0 ? relativePath : relativePath.length === 0 ? prefix : `${prefix}/${relativePath}`;
}

function sourceOf(request: DescriptionRequest, segments: readonly string[]): string {
  return join(request.sourceDisplay, ...segments);
}
