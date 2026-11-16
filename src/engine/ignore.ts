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

/**
 * True when the path `segments`, relative to `root`, is not placed: the ignore file itself, or a
 * path excluded by the rules of `root` or of any directory between it and the path. Each
 * directory's patterns are matched from that directory, and the answers are combined, so a
 * deeper file cannot re-include what a higher one excluded.
 */
export async function isIgnored(tree: IgnoreTree, root: string, segments: readonly string[]): Promise<boolean> {
  if (segments.length === 0) {
    return false;
  }
  if (segments[segments.length - 1] === IGNORE_FILE_NAME) {
    return true;
  }
  for (let depth = 0; depth < segments.length; depth += 1) {
    const rules = await tree.read(join(root, ...segments.slice(0, depth)));
    if (rules.ignores(segments.slice(depth).join("/"))) {
      return true;
    }
  }
  return false;
}
