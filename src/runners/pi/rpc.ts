import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { errorMessage } from "../../engine/config.ts";
import { truncate } from "../../engine/truncate.ts";

const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 3_000;

export interface PiEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export class PiRpcError extends Error {
  readonly diagnostics: readonly string[];

  constructor(message: string, diagnostics: readonly string[] = []) {
    super(message);
    this.name = "PiRpcError";
    this.diagnostics = diagnostics;
  }
}

export interface PiProcessOptions {
  readonly spawn: () => ChildProcessWithoutNullStreams;
  readonly commandTimeoutMs?: number;
  readonly stopGraceMs?: number;
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface EventWaiter {
  readonly type: string;
  readonly resolve: (event: PiEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** Minimal strict-JSONL client for Pi RPC mode. */
export class PiProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #commandTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #waiters = new Set<EventWaiter>();
  readonly #protocolErrors: string[] = [];
  readonly #errorEvents: string[] = [];
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #stderr = "";
  #nextId = 0;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #exitResolve: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  readonly #exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #startupError: Error | undefined;
  #closed = false;
  #stopped = false;
  #stopPromise: Promise<void> | undefined;

  constructor(options: PiProcessOptions) {
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.#exitPromise = new Promise((resolve) => {
      this.#exitResolve = resolve;
    });
    this.#child = options.spawn();
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
    this.#child.on("error", (error) => {
      this.#startupError = new Error(`Pi process failed: ${errorMessage(error)}`);
      this.#failAll(this.#startupError);
    });
    this.#child.on("exit", (code, signal) => {
      this.#exit = { code, signal };
      this.#exitResolve(this.#exit);
      if (!this.#stopped) {
        this.#failAll(new Error(`Pi exited unexpectedly (${describeExit(code, signal)})`));
      }
    });
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  get protocolErrors(): readonly string[] {
    return this.#protocolErrors;
  }

  get errorEvents(): readonly string[] {
    return this.#errorEvents;
  }

  get exited(): boolean {
    return this.#exit !== undefined;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  /** Send a command and resolve its matching successful response. */
  async command(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<unknown> {
    if (this.#startupError !== undefined) {
      throw this.#withDiagnostics(this.#startupError.message);
    }
    if (this.#closed) {
      throw this.#withDiagnostics("cannot send a command after the Pi process was closed");
    }
    const id = `req-${++this.#nextId}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(this.#withDiagnostics(`Pi did not respond to "${type}" within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.#writeLine({ id, type, ...payload });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(this.#withDiagnostics(`could not send "${type}" to Pi: ${errorMessage(error)}`));
      }
    }
    return response;
  }

  /** Register a waiter before issuing the command that triggers the event. */
  waitForEvent(type: string, timeoutMs: number, signal?: AbortSignal): Promise<PiEvent> {
    return new Promise<PiEvent>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiters.delete(waiter);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(this.#withDiagnostics(`Pi did not emit "${type}" within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter: EventWaiter = {
        type,
        resolve: (event) => {
          cleanup();
          resolve(event);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
      };
      const onAbort = () => {
        cleanup();
        reject(this.#withDiagnostics(`waiting for "${type}" was aborted`));
      };
      if (signal?.aborted === true) {
        cleanup();
        reject(this.#withDiagnostics(`waiting for "${type}" was aborted`));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.add(waiter);
    });
  }

  /** Close stdin, then escalate through SIGTERM and SIGKILL for the process group. */
  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    this.#closed = true;
    this.#failAll(this.#withDiagnostics("Pi process was stopped"));
    try {
      this.#child.stdin.end();
    } catch {
      // The process may already have closed its stdin.
    }

    if (this.#exit !== undefined) {
      return;
    }
    if (await this.#waitForExit(this.#stopGraceMs)) {
      return;
    }
    this.#signalGroup("SIGTERM");
    if (await this.#waitForExit(this.#stopGraceMs)) {
      return;
    }
    this.#signalGroup("SIGKILL");
    await this.#waitForExit(this.#stopGraceMs);
  }

  #onStdout(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.#buffer.length > MAX_PROTOCOL_LINE_BYTES) {
          this.#protocolFailure("Pi emitted a protocol line larger than the 2 MiB limit");
        }
        return;
      }
      let line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length === 0) {
        continue;
      }
      this.#onRecord(line.toString("utf8"));
    }
  }

  #onRecord(line: string): void {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("record is not a JSON object");
      }
      record = parsed as Record<string, unknown>;
    } catch (error) {
      this.#protocolFailure(`invalid JSON from Pi: ${errorMessage(error)} (line: ${truncate(line, 160)})`);
      return;
    }

    const type = record.type;
    if (type === "response") {
      this.#onResponse(record);
      return;
    }
    if (typeof type !== "string") {
      this.#protocolFailure(`Pi record has no type (line: ${truncate(line, 160)})`);
      return;
    }
    if (type === "error") {
      this.#errorEvents.push(describeErrorEvent(record));
    }
    const event = record as PiEvent;
    for (const waiter of [...this.#waiters]) {
      if (waiter.type !== type) {
        continue;
      }
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  #onResponse(record: Record<string, unknown>): void {
    const id = record.id;
    if (typeof id !== "string") {
      this.#protocolFailure(`Pi response has no request id: ${truncate(JSON.stringify(record), 160)}`);
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#protocolErrors.push(`response for unknown request id ${id}`);
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (record.success === true) {
      pending.resolve(record.data);
    } else {
      pending.reject(this.#withDiagnostics(`Pi command failed: ${String(record.error ?? "unknown error")}`));
    }
  }

  #protocolFailure(message: string): void {
    this.#protocolErrors.push(message);
    this.#buffer = Buffer.alloc(0);
    this.#failAll(new PiRpcError(message, this.#diagnostics()));
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    for (const waiter of [...this.#waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.#waiters.delete(waiter);
    }
  }

  async #writeLine(record: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    const stdin = this.#child.stdin;
    if (stdin.destroyed || !stdin.writable) {
      throw new Error("stdin is closed");
    }
    if (stdin.write(line)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        stdin.off("drain", onDrain);
        stdin.off("error", onError);
      };
      stdin.once("drain", onDrain);
      stdin.once("error", onError);
    });
  }

  #onStderr(chunk: Buffer): void {
    this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-MAX_STDERR_CHARS);
  }

  #signalGroup(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.#child.kill(signal);
      } catch {
        // The process is already gone.
      }
    }
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exit !== undefined) {
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.#exitPromise.then(() => true), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  #withDiagnostics(message: string): PiRpcError {
    return new PiRpcError(message, this.#diagnostics());
  }

  #diagnostics(): string[] {
    const diagnostics = [...this.#protocolErrors, ...this.#errorEvents];
    if (this.#stderr.trim().length > 0) {
      diagnostics.push(`stderr: ${truncate(this.#stderr.trim(), 2_000)}`);
    }
    return diagnostics;
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    return `signal ${signal}`;
  }
  return `exit code ${String(code)}`;
}

function describeErrorEvent(record: Record<string, unknown>): string {
  const reason = typeof record.reason === "string" ? record.reason : "error";
  const error = typeof record.error === "string" ? record.error : "";
  return truncate(`${reason}${error.length > 0 ? `: ${error}` : ""}`, 500);
}
