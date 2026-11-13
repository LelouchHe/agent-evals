import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientContext,
  type InitializeResponse,
  type NewSessionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { errorMessage } from "../../engine/config.ts";
import type { SupervisedProcess } from "../../platform/macos/supervise.ts";

/**
 * Initialize the agent, create one session in `cwd` and run `use` while the
 * connection is open. Fails when the agent exits or the connection breaks.
 */
export async function withSession<T>(
  process: SupervisedProcess,
  cwd: string,
  onUpdate: (update: SessionUpdate) => void,
  use: (agent: ClientContext, initialized: InitializeResponse, session: NewSessionResponse) => Promise<T>,
): Promise<T> {
  let stderr = "";
  process.child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  const app = client()
    // The sandbox is the permission boundary, so unattended runs approve what the agent asks for.
    .onRequest(methods.client.session.requestPermission, async ({ params: { options } }) => {
      const option =
        options.find((candidate) => candidate.kind === "allow_once") ??
        options.find((candidate) => candidate.kind === "allow_always");
      return {
        outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId },
      };
    })
    .onNotification(methods.client.session.update, async ({ params }) => onUpdate(params.update));
  const exited = process.completion.then((code) => {
    throw new Error(`ACP agent exited with code ${code}`);
  });
  try {
    return await Promise.race([
      exited,
      app.connectWith(
        ndJsonStream(Writable.toWeb(process.child.stdin!), Readable.toWeb(process.child.stdout!)),
        async (agent) => {
          const initialized = await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
          return use(agent, initialized, session);
        },
      ),
    ]);
  } catch (error) {
    if (error instanceof RequestError && error.code === -32000) {
      throw new Error("ACP authentication required; run login with this agent configuration first", { cause: error });
    }
    if (stderr.trim()) {
      throw new Error(`ACP agent failed: ${errorMessage(error)}; stderr: ${stderr.trim()}`, { cause: error });
    }
    throw error;
  }
}
