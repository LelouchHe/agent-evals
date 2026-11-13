import { ClientSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { stringify } from "yaml";
import { loadImplementationParameters } from "../../engine/authoring.ts";
import { ConfigError } from "../../engine/config.ts";
import { createEnvSource } from "../../engine/env-source.ts";
import { spawnSupervised } from "../../platform/macos/supervise.ts";
import { agentSchema } from "./agent.ts";
import { prepareEnvironment } from "./environment.ts";

/** Helpers share the same typed agent configuration and isolated lifecycle. */
export async function runAgentCommand(command: "config" | "login", path: string, signal: AbortSignal): Promise<string> {
  const { params: agent, dir } = await loadImplementationParameters(
    path,
    agentSchema,
    createEnvSource(process.cwd(), signal),
  );
  if (command === "login" && (agent.command === undefined || agent.home.login === undefined || !agent.login?.length)) {
    throw new ConfigError("login requires command, home.login and a non-empty login file list");
  }
  signal.throwIfAborted();
  const environment = await prepareEnvironment(agent, dir, command === "login");
  try {
    const operationSignal = command === "config" ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : signal;
    operationSignal.throwIfAborted();
    const process = await spawnSupervised({
      command: command === "config" ? agent.acpCommand : agent.command!,
      policy: environment.policy,
      policyDirectory: environment.directory,
      cwd: environment.cwd,
      env: environment.env,
      interactive: command === "login",
    });
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
        let stderr = "";
        process.child.stderr!.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4096);
        });
        const connection = new ClientSideConnection(
          () => ({
            requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            sessionUpdate: async () => {},
          }),
          ndJsonStream(Writable.toWeb(process.child.stdin!), Readable.toWeb(process.child.stdout!)),
        );
        try {
          const initialized = await connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await connection.newSession({ cwd: environment.cwd, mcpServers: [] });
          return stringify({ authMethods: initialized.authMethods ?? [], configOptions: session.configOptions ?? [] });
        } catch (error) {
          if (error instanceof RequestError && error.code === -32000) {
            throw new Error("ACP authentication required; run login with this agent configuration first", {
              cause: error,
            });
          }
          if (stderr.trim())
            throw new Error(
              `ACP query failed: ${error instanceof Error ? error.message : String(error)}; stderr: ${stderr.trim()}`,
              { cause: error },
            );
          throw error;
        }
      };
      const output = await Promise.race([work(), cancelled]);
      operationSignal.throwIfAborted();
      if (command === "login") await environment.saveLogin(agent.login!);
      return output;
    } finally {
      operationSignal.removeEventListener("abort", onAbort);
      await process.stop();
      await environment.copyBack();
    }
  } finally {
    await environment.dispose();
  }
}
