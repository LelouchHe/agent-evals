import { RE2JS } from "re2js";

/**
 * Compile one RE2 pattern. RE2 rejects lookaround and backreferences, so every accepted pattern
 * is linear-time and can run in the engine without a worker or a timeout.
 */
export function compilePattern(source: string): RE2JS {
  return RE2JS.compile(source);
}

/** True when the pattern matches anywhere in the text; the normal search semantics. */
export function searches(source: string, text: string): boolean {
  return compilePattern(source).matcher(text).find();
}

/** True when the pattern matches the whole text, as an argv token is matched. */
export function matchesWhole(source: string, text: string): boolean {
  return compilePattern(source).matcher(text).matches();
}
