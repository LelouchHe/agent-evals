import { parentPort, workerData } from "node:worker_threads";

interface WorkerInput {
  readonly content: string;
  readonly patterns: readonly string[];
}

const input = workerData as WorkerInput;
if (parentPort === null) {
  process.exitCode = 1;
} else {
  for (const [index, pattern] of input.patterns.entries()) {
    try {
      const regex = new RegExp(pattern);
      parentPort.postMessage({ index, matched: regex.test(input.content) });
    } catch (error) {
      parentPort.postMessage({ index, error: error instanceof Error ? error.message : String(error) });
    }
  }
  parentPort.postMessage({ done: true });
}
