import { methods, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { loadImplementationParameters } from "../../engine/authoring.ts";
import { resolveAuthoringAsset } from "../../engine/config.ts";
import type { Runner, RunnerContext, RunnerDefinition, RunnerOutcome } from "../../engine/registry.ts";
import { spawnSupervised, type SupervisedProcess } from "../../platform/index.ts";
import { agentSchema } from "./agent.ts";
import { harnessEnvironment, prepareHarnessHome, resolveHarnessHome, type HarnessHome } from "./environment.ts";
import { withSession } from "./session.ts";
import { AcpTrace } from "./trace.ts";
import { AcpUsage } from "./usage.ts";

const acpRunnerParamsSchema = z.strictObject({
  /** Inline agent startup object, or a path to a standalone file holding the same object. */
  agent: z.union([z.string().min(1), agentSchema]),
  /** Session config values keyed by option category, otherwise option ID; applied in order. */
  config: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
});

type AcpRunnerParams = z.output<typeof acpRunnerParamsSchema>;
type SessionConfig = AcpRunnerParams["config"];

/** Generic ACP runner: one prompt turn in a caller-prepared harness home under Seatbelt. */
export const acpRunner: RunnerDefinition<AcpRunnerParams> = {
  type: "acp",
  params: acpRunnerParamsSchema,
  mocks: true,
  home: true,
  async create(params, context) {
    const { params: agent, dir } =
      typeof params.agent === "string"
        ? await loadImplementationParameters(
            resolveAuthoringAsset(context.authoringDir, params.agent, "acp runner agent"),
            agentSchema,
            context.values,
          )
        : { params: params.agent, dir: context.authoringDir };
    return new AcpRunner(agent.acpCommand, await resolveHarnessHome(agent, dir), params.config);
  },
};

class AcpRunner implements Runner {
  readonly #command: readonly [string, ...string[]];
  readonly #home: HarnessHome;
  readonly homeFiles: readonly string[];
  readonly concurrencyKey?: string;
  readonly #config: SessionConfig;
  #process: SupervisedProcess | undefined;
  #copyBack: (() => Promise<void>) | undefined;
  #stopped: Promise<void> | undefined;
  readonly #trace = new AcpTrace();
  readonly #usage = new AcpUsage();

  constructor(command: readonly [string, ...string[]], home: HarnessHome, config: SessionConfig) {
    this.#command = command;
    this.#home = home;
    this.homeFiles = home.login?.files ?? [];
    if (home.login !== undefined) {
      this.concurrencyKey = home.login.dir;
    }
    this.#config = config;
  }

  /** Place the agent file's HOME content and login state before the case's own `~/` entries. */
  readonly prepareHome = async (context: RunnerContext): Promise<readonly string[]> => {
    const prepared = await prepareHarnessHome(
      this.#home,
      { home: context.homeDir, runRootDir: context.runRootDir, engineDir: context.engineDir },
      context.signal,
    );
    this.#copyBack = prepared.copyBack;
    return prepared.protectedPaths;
  };

  readonly run = async (context: RunnerContext): Promise<RunnerOutcome> => {
    const environment = await harnessEnvironment(
      this.#home,
      {
        home: context.homeDir,
        workspace: context.workspaceDir,
        tmp: context.tmpDir,
        runRootDir: context.runRootDir,
      },
      {
        interactive: false,
        ...(context.mocks === undefined ? {} : { mocks: context.mocks }),
      },
    );
    this.#process = await spawnSupervised({
      command: this.#command,
      policy: environment.policy,
      // Outside everything the sandbox can read.
      policyDirectory: context.engineDir,
      cwd: context.workspaceDir,
      env: environment.env,
      interactive: false,
    });
    // Stopping the sandbox closes the connection, which fails the pending request.
    const onAbort = () => void this.stop().catch(() => {});
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      context.signal.throwIfAborted();
      await withSession(
        this.#process,
        context.workspaceDir,
        (update) => {
          this.#trace.add(update);
          this.#usage.add(update);
        },
        async (agent, _initialized, session) => {
          const { sessionId } = session;
          let options = session.configOptions ?? [];
          for (const [key, value] of Object.entries(this.#config)) {
            const configId = offeredOption(options, key, value).id;
            const request = typeof value === "boolean" ? { type: "boolean" as const, value } : { value };
            options = (await agent.request(methods.agent.session.setConfigOption, { sessionId, configId, ...request }))
              .configOptions;
          }
          const response = await agent.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: context.input }],
          });
          this.#usage.setPromptUsage(response);
          if (response.stopReason !== "end_turn") {
            throw new Error(`ACP turn stopped with ${response.stopReason}`);
          }
        },
      );
      return { finalText: this.#trace.finalText(), diagnostics: [] };
    } finally {
      context.signal.removeEventListener("abort", onAbort);
    }
  };

  readonly trace = () => this.#trace.entries;

  readonly usage = () => this.#usage.value;

  /** Stop the whole sandbox, then keep login changes the harness made to its original files. */
  readonly stop = async (): Promise<void> => {
    const process = this.#process;
    if (process === undefined) return;
    await (this.#stopped ??= (async () => {
      await process.stop();
      await this.#copyBack?.();
    })());
  };
}

/** Find the option a config key names and require that the agent offers the value. */
function offeredOption(
  options: readonly SessionConfigOption[],
  key: string,
  value: string | boolean,
): SessionConfigOption {
  const inCategory = options.filter((option) => option.category === key);
  const option = inCategory.length === 1 ? inCategory[0] : options.find((candidate) => candidate.id === key);
  if (option === undefined) {
    const available = options.map((candidate) => candidate.category ?? candidate.id).join(", ") || "none";
    throw new Error(`ACP config "${key}" matches no single option category or ID (available: ${available})`);
  }
  const offered: (string | boolean)[] =
    option.type === "boolean"
      ? [true, false]
      : option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry])).map((entry) => entry.value);
  if (!offered.includes(value)) {
    throw new Error(`ACP config "${key}" does not offer ${JSON.stringify(value)} (available: ${offered.join(", ")})`);
  }
  return option;
}
