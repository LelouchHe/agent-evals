import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, errorMessage } from "./config.ts";
import { isMissing } from "./workspace.ts";

/** The file a source directory uses to declare what is not placed into a run. */
export const IGNORE_FILE_NAME = ".agentevalsignore";

/** One ignore pattern, as path segments relative to the directory holding the ignore file. */
export type IgnorePattern = readonly string[];

/**
 * Read one directory's ignore patterns. Patterns are relative to that directory, so the same
 * declarations work whether one skill directory or a whole skills tree is the copy source.
 * Whitespace and blank lines are ignored and a line starting with `#` is a comment.
 */
export async function readIgnorePatterns(dir: string): Promise<readonly IgnorePattern[]> {
  const path = join(dir, IGNORE_FILE_NAME);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw new ConfigError(`could not read ${path}: ${errorMessage(error)}`);
  }
  const patterns: IgnorePattern[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.length > 0 && !line.startsWith("#")) {
      patterns.push(parsePattern(line, path, index + 1));
    }
  }
  return patterns;
}

/**
 * Parse one pattern line. The language is deliberately tiny: a relative path whose segments are
 * literal or `*`, where `*` matches exactly one segment. Anything resembling a fuller glob is a
 * configuration error, so an unsupported intent never becomes a silent no-op.
 */
function parsePattern(line: string, file: string, lineNumber: number): IgnorePattern {
  const reject = (reason: string): never => {
    throw new ConfigError(`${file}:${lineNumber}: pattern "${line}" ${reason}`);
  };
  if (line.includes("\0")) reject("contains a NUL byte");
  if (line.includes("\\")) reject("must separate segments with /");
  if (line.includes("**")) reject('has no "**"; "*" matches exactly one segment');
  const trimmed = line.endsWith("/") ? line.slice(0, -1) : line;
  if (isAbsoluteLike(trimmed)) reject("must be relative to the directory that holds the ignore file");
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment.length === 0) reject("has an empty segment");
    if (segment === "." || segment === "..") reject(`must not contain "${segment}"`);
    if (segment !== "*" && segment.includes("*")) reject('uses "*" inside a segment; a segment is "*" or literal');
  }
  return segments;
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** True when `relative` (segments from the ignore file's directory) matches one pattern. */
export function matchesIgnorePattern(patterns: readonly IgnorePattern[], relative: readonly string[]): boolean {
  return patterns.some(
    (pattern) =>
      pattern.length === relative.length &&
      pattern.every((segment, index) => segment === "*" || segment === relative[index]),
  );
}
