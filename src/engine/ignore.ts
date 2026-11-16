import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { ConfigError, errorMessage } from "./config.ts";
import { isMissing } from "./workspace.ts";

/** The file a source directory uses to declare what is not placed into a run. */
export const IGNORE_FILE_NAME = ".agentevalsignore";

/**
 * The ignore files one copy consults, read at most once per directory and kept for that copy so
 * two entries sharing a subtree share the answers.
 */
export class IgnoreTree {
  readonly #rules = new Map<string, Promise<Ignore>>();

  read(dir: string): Promise<Ignore> {
    let rules = this.#rules.get(dir);
    if (rules === undefined) {
      rules = readRules(dir);
      this.#rules.set(dir, rules);
    }
    return rules;
  }
}

/** Parse one directory's ignore file with the gitignore implementation; no file means no rules. */
async function readRules(dir: string): Promise<Ignore> {
  const path = join(dir, IGNORE_FILE_NAME);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return ignore();
    }
    throw new ConfigError(`could not read ${path}: ${errorMessage(error)}`);
  }
  return ignore().add(text);
}

/** One exclusion: the path, and the ignore file whose rules decided it. */
export interface IgnoreDecision {
  readonly ignored: boolean;
  /** The `.agentevalsignore` file that decided the exclusion. */
  readonly file?: string;
}

/**
 * Decide whether the path `segments`, relative to `root`, is not placed, and which ignore file
 * decided it. Each directory's patterns are matched from that directory, and the answers are
 * combined, so a deeper file cannot re-include what a higher one excluded; the first (highest)
 * decision is the one reported.
 *
 * `directory` supplies the one thing a bare path cannot: a trailing `/` marks the entry as a
 * directory, which is how gitignore spells a directory-only pattern such as `evals/`.
 */
export async function ignoreDecision(
  tree: IgnoreTree,
  root: string,
  segments: readonly string[],
  directory: boolean,
): Promise<IgnoreDecision> {
  if (segments.length === 0) {
    return { ignored: false };
  }
  if (segments[segments.length - 1] === IGNORE_FILE_NAME) {
    return { ignored: true, file: join(root, ...segments) };
  }
  for (let depth = 0; depth < segments.length; depth += 1) {
    const directoryPath = join(root, ...segments.slice(0, depth));
    const rules = await tree.read(directoryPath);
    const relative = segments.slice(depth).join("/") + (directory ? "/" : "");
    if (rules.ignores(relative)) {
      return { ignored: true, file: join(directoryPath, IGNORE_FILE_NAME) };
    }
  }
  return { ignored: false };
}

/** True when the path is not placed, as {@link ignoreDecision} decides. */
export async function isIgnored(
  tree: IgnoreTree,
  root: string,
  segments: readonly string[],
  directory: boolean,
): Promise<boolean> {
  return (await ignoreDecision(tree, root, segments, directory)).ignored;
}
