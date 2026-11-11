import { Worker } from "node:worker_threads";

/** Hard ceiling for one regex evaluation batch, enforced by worker termination. */
const REGEX_EVALUATION_TIMEOUT_MS = 5_000;

export interface RegexEvaluation {
  /** Matched results by pattern index; undefined means the attempt did not finish. */
  readonly matched: readonly (boolean | undefined)[];
  /** Per-pattern compile errors, which normally are caught during validation. */
  readonly errors: readonly (string | undefined)[];
  /** Reason for any unresolved patterns, such as timeout or cancellation. */
  readonly failure?: string;
}

/**
 * Evaluate regexes in a worker so a catastrophic valid expression cannot block
 * the engine event loop. Timeout or cancellation terminates the worker, which
 * stops the computation instead of merely abandoning a same-loop promise.
 */
export function evaluateRegexes(
  content: string,
  patterns: readonly string[],
  signal: AbortSignal,
): Promise<RegexEvaluation> {
  const matched: (boolean | undefined)[] = new Array(patterns.length).fill(undefined);
  const errors: (string | undefined)[] = new Array(patterns.length).fill(undefined);

  if (signal.aborted) {
    return Promise.resolve({ matched, errors, failure: "regex evaluation was cancelled" });
  }

  return new Promise<RegexEvaluation>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./regex-worker.ts", import.meta.url), {
        workerData: { content, patterns },
      });
    } catch (error) {
      resolve({ matched, errors, failure: `could not start regex worker: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    const finish = (failure?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => {});
      resolve({ matched, errors, ...(failure === undefined ? {} : { failure }) });
    };

    const onAbort = (): void => finish("regex evaluation was cancelled");
    const onMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null) {
        return;
      }
      const record = message as Record<string, unknown>;
      if (record.done === true) {
        finish();
        return;
      }
      const index = record.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= patterns.length) {
        return;
      }
      if (typeof record.matched === "boolean") {
        matched[index] = record.matched;
      } else if (typeof record.error === "string") {
        errors[index] = record.error;
      }
    };

    worker.on("message", onMessage);
    worker.on("error", (error) => finish(`regex worker failed: ${error.message}`));
    worker.on("exit", (code) => {
      if (!settled) {
        finish(`regex worker exited unexpectedly with code ${String(code)}`);
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(`regex evaluation exceeded ${REGEX_EVALUATION_TIMEOUT_MS}ms`), REGEX_EVALUATION_TIMEOUT_MS);
  });
}
