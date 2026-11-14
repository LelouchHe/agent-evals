import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadImplementationParameters } from "../../engine/authoring.ts";
import { ConfigError, errorMessage } from "../../engine/config.ts";
import { createEnvSource } from "../../engine/env-source.ts";
import { spawnSupervised, type SupervisedProcess } from "../../platform/macos/supervise.ts";
import { agentSchema } from "./agent.ts";
import { assembleEnvironment, resolveHome } from "./environment.ts";
import { withSession } from "./session.ts";

/** Helpers share the same typed agent configuration and isolated lifecycle. */
export async function runAgentCommand(command: "config" | "login", path: string, signal: AbortSignal): Promise<string> {
  // Placeholders need the directories' paths; they are created only after validation.
  const directory = join(tmpdir(), `ae-acp-${randomBytes(6).toString("hex")}`);
  const dirs = {
    home: join(directory, "home"),
    workspace: join(directory, "workspace"),
    scratch: join(directory, "tmp"),
  };
  const { params: agent, dir } = await loadImplementationParameters(path, agentSchema, {
    env: createEnvSource(process.cwd(), signal),
    run: { HOME: dirs.home, TMPDIR: dirs.scratch },
  });
  if (command === "login" && (agent.command === undefined || agent.home.login === undefined || !agent.login?.length)) {
    throw new ConfigError("login requires command, home.login and a non-empty login file list");
  }
  signal.throwIfAborted();
  const home = await resolveHome(agent, dir);
  // Exclusive creation, like mkdtemp: an existing path is an error, not reused.
  await mkdir(directory, { mode: 0o700 });
  const failures: unknown[] = [];
  let output = "";
  let environment: Awaited<ReturnType<typeof assembleEnvironment>> | undefined;
  let supervised: SupervisedProcess | undefined;
  try {
    await Promise.all(Object.values(dirs).map((path) => mkdir(path, { mode: 0o700 })));
    environment = await assembleEnvironment(home, dirs, { interactive: command === "login" });
    const operationSignal = command === "config" ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : signal;
    operationSignal.throwIfAborted();
    const process = await spawnSupervised({
      command: command === "config" ? agent.acpCommand : agent.command!,
      policy: environment.policy,
      policyDirectory: directory,
      cwd: dirs.workspace,
      env: environment.env,
      interactive: command === "login",
    });
    supervised = process;
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          new Error(
            operationSignal.reason?.name === "TimeoutError"
              ? "ACP configuration query timed out after 30000ms"
              : `${command} cancelled`,
          ),
        );
      operationSignal.addEventListener("abort", onAbort, { once: true });
      if (operationSignal.aborted) onAbort();
    });
    try {
      const work = async (): Promise<string> => {
        if (command === "login") {
          const code = await process.completion;
          operationSignal.throwIfAborted();
          if (code !== 0) throw new Error(`login command exited with code ${code}`);
          return "Login files saved.\n";
        }
        return withSession(
          process,
          dirs.workspace,
          () => {},
          async (_agent, initialized, session) =>
            stringify({ authMethods: initialized.authMethods ?? [], configOptions: session.configOptions ?? [] }),
        );
      };
      output = await Promise.race([work(), cancelled]);
      operationSignal.throwIfAborted();
      if (command === "login") await environment.saveLogin(agent.login!);
    } finally {
      operationSignal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    if (supervised !== undefined) {
      await supervised.stop();
      await environment!.copyBack();
    }
  } catch (error) {
    failures.push(new Error(`cleanup failed: ${errorMessage(error)}`, { cause: error }));
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    failures.push(new Error(`cleanup failed: ${errorMessage(error)}`, { cause: error }));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map(errorMessage).join("; "), { cause: failures[0] });
  }
  return output;
}
