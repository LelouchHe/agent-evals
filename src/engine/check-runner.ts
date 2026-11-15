import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

/**
 * In-sandbox check-program launcher.
 *
 * Starts the author's program with exactly `PATH`, `HOME` and `TMPDIR`, and
 * reports its exact wait status or exec failure over the host's private report
 * pipe at FD 5 (never inherited by the untrusted child).
 */

type Outcome =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "signalled"; readonly signal: string }
  | { readonly kind: "failed"; readonly reason: string };

const [program, ...args] = process.argv.slice(2);
let settled = false;

function report(outcome: Outcome): void {
  if (settled) return;
  settled = true;
  try {
    writeSync(5, JSON.stringify(outcome) + "\n");
  } catch {
    // Host closed the report pipe (for example on timeout or cancellation).
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

if (program === undefined) {
  report({ kind: "failed", reason: "the check named no program" });
} else {
  try {
    const child = spawn(program, args, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (error) => {
      report({ kind: "failed", reason: `could not start ${program}: ${errorCode(error)}` });
    });
    child.on("close", (code, signal) => {
      report(signal === null ? { kind: "exited", exitCode: code ?? 1 } : { kind: "signalled", signal });
    });
  } catch (error) {
    report({ kind: "failed", reason: `could not start ${program}: ${errorCode(error)}` });
  }
}
