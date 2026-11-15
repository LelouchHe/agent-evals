import type { RE2JS } from "re2js";
import {
  workspaceTargetPath,
  type MockAction,
  type MockArgument,
  type MockPattern,
  type MockRule,
  type ShellMocks,
} from "./config.ts";
import { compilePattern } from "./regex.ts";

interface CompiledPattern {
  readonly literal: string | undefined;
  readonly re: RE2JS | undefined;
}

type CompiledArgument =
  | { readonly key: CompiledPattern; readonly kind: "required" | "forbidden" }
  | { readonly key: CompiledPattern; readonly kind: "value"; readonly value: CompiledPattern };

interface CompiledRule {
  /** Absent for the fallback rule. */
  readonly positional: readonly CompiledPattern[] | undefined;
  readonly options: readonly CompiledArgument[] | undefined;
  readonly action: MockAction;
}

/** One target's compiled ordered rules. */
export type CompiledRules = readonly CompiledRule[];

/** One workspace target: the declared spelling and its compiled rules. */
export interface CompiledWorkspaceTarget {
  readonly target: string;
  readonly rules: CompiledRules;
}

/** Compiled rules split by where the target lives; a bare name and `./name` differ. */
export interface CompiledShellMocks {
  readonly path: ReadonlyMap<string, CompiledRules>;
  readonly workspace: ReadonlyMap<string, CompiledWorkspaceTarget>;
}

/** Compile every pattern once, when the host starts. Invalid patterns already failed at load. */
export function compileShellMocks(shell: ShellMocks): CompiledShellMocks {
  const path = new Map<string, CompiledRules>();
  const workspace = new Map<string, CompiledWorkspaceTarget>();
  for (const [target, rules] of Object.entries(shell)) {
    const compiled = compileRules(rules);
    if (target.includes("/")) {
      workspace.set(workspaceTargetPath(target), { target, rules: compiled });
    } else {
      path.set(target, compiled);
    }
  }
  return { path, workspace };
}

/** Compile one target's ordered rules; the same path serves the host and a mock check. */
export function compileRules(rules: readonly MockRule[]): CompiledRules {
  return rules.map(compileRule);
}

function compileRule(rule: MockRule): CompiledRule {
  if (rule.args === undefined) {
    return { positional: undefined, options: undefined, action: rule.action };
  }
  return {
    positional: rule.args.positional.map(compilePatternOf),
    options: rule.args.options.map(compileArgument),
    action: rule.action,
  };
}

function compileArgument(option: MockArgument): CompiledArgument {
  const key = compilePatternOf(option.key);
  if (option.kind === "value") {
    return { key, kind: "value", value: compilePatternOf(option.value) };
  }
  return { key, kind: option.kind };
}

function compilePatternOf(pattern: MockPattern): CompiledPattern {
  return pattern.regex
    ? { literal: undefined, re: compilePattern(pattern.source) }
    : { literal: pattern.source, re: undefined };
}

function tokenMatches(pattern: CompiledPattern, token: string): boolean {
  return pattern.re !== undefined ? pattern.re.matcher(token).matches() : pattern.literal === token;
}

/** The option name is the whole token, or the part before `=` in `--name=value`. */
function nameMatches(pattern: CompiledPattern, token: string): boolean {
  if (tokenMatches(pattern, token)) return true;
  const separator = token.indexOf("=");
  return separator > 0 && tokenMatches(pattern, token.slice(0, separator));
}

/** First matching rule wins; a rule without conditions is the fallback. */
export function matchCall(rules: CompiledRules, argv: readonly string[]): MockAction | undefined {
  for (const rule of rules) {
    if (rule.positional === undefined || argsMatch(rule.positional, rule.options ?? [], argv)) {
      return rule.action;
    }
  }
  return undefined;
}

function argsMatch(
  positional: readonly CompiledPattern[],
  options: readonly CompiledArgument[],
  argv: readonly string[],
): boolean {
  if (argv.length < positional.length) return false;
  for (const [index, pattern] of positional.entries()) {
    if (!tokenMatches(pattern, argv[index] as string)) return false;
  }
  const rest = argv.slice(positional.length);
  return options.every((option) => optionMatches(option, rest));
}

function optionMatches(option: CompiledArgument, tokens: readonly string[]): boolean {
  if (option.kind === "value") {
    const { key, value } = option;
    return tokens.some((token, index) => {
      // Both promised spellings: `--name=value` first, then `--name value`. A regex name may
      // match the whole `--name=value` token, so splitting cannot depend on that check.
      const separator = token.indexOf("=");
      if (
        separator > 0 &&
        tokenMatches(key, token.slice(0, separator)) &&
        tokenMatches(value, token.slice(separator + 1))
      ) {
        return true;
      }
      if (!tokenMatches(key, token)) return false;
      const next = tokens[index + 1];
      return next !== undefined && tokenMatches(value, next);
    });
  }
  if (option.kind === "required") {
    return tokens.some((token) => nameMatches(option.key, token));
  }
  return !tokens.some((token) => nameMatches(option.key, token));
}
