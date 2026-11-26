import assert from "node:assert/strict";
import { link, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import type {
  CheckerContext,
  HomeProtection,
  ImplementationContext,
  PreparedRunner,
  Runner,
  RunnerContext,
} from "../../engine/registry.ts";
import { fileIdentity, openRunRoot } from "../../engine/workspace.ts";
import { piRunner } from "../../runners/pi/index.ts";
import { createFakePi, makeTempDir, type FakePi } from "../../../tests/helpers/fake-pi-control.ts";
import { implementationContext, unusedCheckSandbox } from "../../../tests/helpers/implementation-context.ts";
import { judgeChecker, JudgeError } from "./index.ts";

async function setup(t: Parameters<typeof makeTempDir>[0], fileContent: string | null = "Hello, world!\n") {
  const root = await makeTempDir(t, "ae-judge-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  const home = join(root, "home");
  const homeBaseline = join(root, "home-baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  await mkdir(home);
  await mkdir(homeBaseline);
  if (fileContent !== null) {
    await writeFile(join(workspace, "hello.txt"), fileContent);
  }
  return { root, workspace, baseline, home, homeBaseline };
}

async function context(
  root: string,
  workspace: string,
  baseline: string,
  extra: { readonly protectedHome?: HomeProtection } = {},
): Promise<CheckerContext> {
  return {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    home: await openRunRoot(join(root, "home")),
    homeBaseline: await openRunRoot(join(root, "home-baseline")),
    ...(extra.protectedHome === undefined ? {} : { protectedHome: extra.protectedHome }),
    runRootDir: root,
    input: "Create hello.txt with exactly the content Hello, world!",
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(10_000),
    checkSandbox: unusedCheckSandbox,
  };
}

/** The engine capability the judge asks for, with the declaration it was given. */
type CreateRunner = ImplementationContext["createRunner"];

/** Create the declared Pi runner the way the engine does: same schema, same context. */
const createDeclaredRunner: CreateRunner = async (record) => {
  const { $type: _type, ...declared } = record ?? {};
  return {
    type: "pi",
    runner: await piRunner.create(
      await parseImplementationParams(piRunner.params, declared, 'runner "pi"'),
      implementationContext(process.cwd()),
    ),
  };
};

/** A runner declaration naming the fake executable, as a case would write it. */
function piDeclaration(fake: FakePi, extra: Readonly<Record<string, unknown>> = {}) {
  return { $type: "pi", model: "test/judge-model", thinking: "low", executable: fake.executable, ...extra };
}

function params(declaration: Readonly<Record<string, unknown>> | undefined, rubric?: string[]) {
  return {
    ...(declaration === undefined ? {} : { runner: declaration }),
    files: ["hello.txt"],
    rubric: rubric ?? ["hello.txt exists and contains Hello, world!."],
  };
}

async function prepare(
  raw: ImplementationParams,
  createRunner: CreateRunner,
  options: { readonly runnerSupportsHome?: boolean } = {},
) {
  const parsed = await parseImplementationParams(judgeChecker.params, raw, 'checker "judge"');
  return judgeChecker.create(parsed, {
    ...implementationContext(process.cwd()),
    ...(options.runnerSupportsHome === undefined ? {} : { runnerSupportsHome: options.runnerSupportsHome }),
    createRunner,
  });
}

async function judge(
  raw: ImplementationParams,
  contextValue: CheckerContext,
  createRunner: CreateRunner = createDeclaredRunner,
  options: { readonly runnerSupportsHome?: boolean } = {},
) {
  return (await prepare(raw, createRunner, options)).check(contextValue);
}

test("judge passes when every rubric statement passes", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-valid");

  const results = await judge(params(piDeclaration(fake)), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, "pass");
  assert.equal(results[0]?.checker, "judge");
  assert.equal(results[0]?.subject, "hello.txt exists and contains Hello, world!.");
  assert.match(results[0]?.reason ?? "", /^\[pi \(test\/judge-model\)\] /);
});

test("judge preserves a valid failing verdict as a failed check", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-fail");

  const results = await judge(params(piDeclaration(fake)), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.equal(results[0]?.status, "fail");
  assert.match(results[0]?.reason ?? "", /differs/);
});

test("judge accepts a fenced JSON verdict", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-fenced");

  const results = await judge(params(piDeclaration(fake)), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.equal(results[0]?.status, "pass");
});

test("judge reports malformed verdicts as checker failures, not failed checks", async (t) => {
  const dirs = await setup(t);

  for (const scenario of ["judge-invalid", "judge-count", "judge-type"]) {
    const fake = await createFakePi(t, scenario);
    await assert.rejects(
      async () => judge(params(piDeclaration(fake)), await context(dirs.root, dirs.workspace, dirs.baseline)),
      JudgeError,
      scenario,
    );
  }
});

test("judge invocation failure is a checker failure", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "crash");

  await assert.rejects(
    async () => judge(params(piDeclaration(fake)), await context(dirs.root, dirs.workspace, dirs.baseline)),
    JudgeError,
  );
});

test("the prompt names the task, the evidence and the rubric, and carries no evidence content", async (t) => {
  const dirs = await setup(t, "file-content-sentinel\n");
  const fake = await createFakePi(t, "judge-echo");

  const results = await judge(params(piDeclaration(fake)), await context(dirs.root, dirs.workspace, dirs.baseline));
  const prompt = results[0]?.reason ?? "";
  assert.match(prompt, /Create hello\.txt/);
  assert.match(prompt, /workspace\/hello\.txt: a file from the run's workspace/);
  assert.match(prompt, /Rubric statements/);
  assert.match(prompt, /hello\.txt exists and contains/);
  assert.doesNotMatch(prompt, /file-content-sentinel/);
});

test("the judge stages a copy of the named file under workspace/ and leaves the run's workspace alone", async (t) => {
  const dirs = await setup(t, "staged-sentinel\n");
  const fake = await createFakePi(t, "judge-evidence");

  const results = await judge(params(piDeclaration(fake)), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.match(results[0]?.reason ?? "", /files:workspace\/hello\.txt=staged-sentinel$/);
  assert.equal(await readFile(join(dirs.workspace, "hello.txt"), "utf8"), "staged-sentinel\n");
});

test("a trailing separator in the evidence path stages and advertises the same file", async (t) => {
  const dirs = await setup(t, "slash-sentinel\n");
  const fake = await createFakePi(t, "judge-evidence");
  const { files: _files, ...rest } = params(piDeclaration(fake));

  const results = await judge(
    { ...rest, files: ["hello.txt/"] },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  // One entry, under the name the read resolved to rather than the spelling that was declared.
  assert.match(results[0]?.reason ?? "", /files:workspace\/hello\.txt=slash-sentinel$/);
});

test("a backslash is part of the file name, not a separator", async (t) => {
  const dirs = await setup(t, "backslash-sentinel\n");
  await writeFile(join(dirs.workspace, "hello.txt\\"), "backslash-sentinel\n");
  const fake = await createFakePi(t, "judge-evidence");
  const { files: _files, ...rest } = params(piDeclaration(fake));

  const results = await judge(
    { ...rest, files: ["hello.txt\\"] },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  const reason = results[0]?.reason ?? "";
  // The backslash stays part of the name, so the staged entry is `workspace/hello.txt\`, not `workspace/hello.txt`.
  assert.match(reason, /files:workspace\/hello\.txt\\=backslash-sentinel$/);
  assert.doesNotMatch(reason, /files:workspace\/hello\.txt=/);
});

test("the judge stages the rendered trace and the prompt names it instead of a file", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-evidence");
  const { files: _files, ...traceOnly } = params(piDeclaration(fake), ["The agent read the log."]);
  const trace = [
    { type: "message", text: "The certificate expired." },
    { type: "tool", toolCallId: "a", title: "cat deploy.log" },
  ] as const;

  const results = await judge(
    { ...traceOnly, trace: true },
    { ...(await context(dirs.root, dirs.workspace, dirs.baseline)), trace },
  );
  const reason = results[0]?.reason ?? "";
  assert.match(reason, /files:trace\.md=\[1\] message/);
  assert.match(reason, /tool call: cat deploy\.log/);
});

test("a trace-only judge names no file in its prompt", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-echo");
  const { files: _files, ...traceOnly } = params(piDeclaration(fake), ["The agent read the log."]);

  const results = await judge(
    { ...traceOnly, trace: true },
    {
      ...(await context(dirs.root, dirs.workspace, dirs.baseline)),
      trace: [{ type: "message", text: "The certificate expired." }],
    },
  );
  const prompt = results[0]?.reason ?? "";
  assert.match(prompt, /trace\.md: the run's messages/);
  assert.doesNotMatch(prompt, /hello\.txt: /);
  // The trace reaches the judge as a staged file, never as text inside the prompt.
  assert.doesNotMatch(prompt, /The certificate expired\./);
});

test("judge trace evidence without a runner trace is a checker error", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-valid");

  await assert.rejects(
    judge({ ...params(piDeclaration(fake)), trace: true }, await context(dirs.root, dirs.workspace, dirs.baseline)),
    (error: unknown) => error instanceof JudgeError && /runner records no trace/.test(error.message),
  );
});

test("a file the run never wrote is staged as absent and named as missing", async (t) => {
  const dirs = await setup(t, null);
  const fake = await createFakePi(t, "judge-echo");

  const results = await judge(params(piDeclaration(fake)), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.match(results[0]?.reason ?? "", /the run produced no such file/);

  // Nothing is materialized in its place: the judge's workspace holds no stand-in file.
  const absent = await createFakePi(t, "judge-evidence");
  const staged = await judge(params(piDeclaration(absent)), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.match(staged[0]?.reason ?? "", /files:\(none\)/);
});

test("the declared runner record reaches the engine, and an undeclared one inherits the case runner", async (t) => {
  const dirs = await setup(t);
  const seen: (undefined | Readonly<Record<string, unknown>>)[] = [];
  const stub: Runner = {
    prepareHome: async () => [],
    run: async () => ({ finalText: '{"criteria":[{"pass":true,"reason":"ok"}]}', diagnostics: [] }),
    stop: async () => {},
  };
  const createRunner: CreateRunner = async (record) => {
    seen.push(record);
    return { type: "stub", runner: stub } satisfies PreparedRunner;
  };

  await judge(params(undefined), await context(dirs.root, dirs.workspace, dirs.baseline), createRunner);
  await judge(
    params({ $type: "stub", model: "other/model", apiKey: "${env:IGNORED}" }),
    await context(dirs.root, dirs.workspace, dirs.baseline),
    createRunner,
  );
  assert.deepEqual(seen, [undefined, { $type: "stub", model: "other/model", apiKey: "${env:IGNORED}" }]);
});

test("a runner that declares HOME preparation receives it before the prompt", async (t) => {
  const dirs = await setup(t);
  const steps: string[] = [];
  const stub: Runner = {
    prepareHome: async (run: RunnerContext) => {
      const privateRoot = run.runRootDir !== dirs.root && run.workspaceDir === join(run.runRootDir, "workspace");
      steps.push(`prepareHome:${privateRoot && run.workspaceDir !== dirs.workspace}`);
      return [];
    },
    run: async (run: RunnerContext) => {
      steps.push(`run:${run.input.includes("Rubric statements")}`);
      return { finalText: '{"criteria":[{"pass":true,"reason":"ok"}]}', diagnostics: [] };
    },
    stop: async () => {},
  };

  await judge(params(undefined), await context(dirs.root, dirs.workspace, dirs.baseline), async () => ({
    type: "stub",
    runner: stub,
  }));
  assert.deepEqual(steps, ["prepareHome:true", "run:true"]);
});

test("a runner that fails to stop turns a verdict into a checker error", async (t) => {
  const dirs = await setup(t);
  const stub: Runner = {
    run: async () => ({ finalText: '{"criteria":[{"pass":true,"reason":"ok"}]}', diagnostics: [] }),
    stop: async () => {
      throw new Error("cleanup failed");
    },
  };

  await assert.rejects(
    judge(params(undefined), await context(dirs.root, dirs.workspace, dirs.baseline), async () => ({
      type: "stub",
      runner: stub,
    })),
    (error: unknown) => error instanceof JudgeError && /judge teardown failed: cleanup failed/.test(error.message),
  );
});

test("aborting the run stops the judge's runner instead of waiting for it", async (t) => {
  const dirs = await setup(t);
  const verdict = { finalText: '{"criteria":[{"pass":true,"reason":"ok"}]}', diagnostics: [] };
  const stops: string[] = [];
  let stopped = false;
  let release: (() => void) | undefined;
  const stub: Runner = {
    // Only the runner's own stop releases it: nothing else would end this run.
    run: () => {
      if (stopped) return Promise.resolve(verdict);
      started?.();
      return new Promise((resolve) => {
        release = () => resolve(verdict);
      });
    },
    stop: async () => {
      stopped = true;
      stops.push("stop");
      release?.();
    },
  };
  const controller = new AbortController();
  let started: (() => void) | undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const checkContext = {
    ...(await context(dirs.root, dirs.workspace, dirs.baseline)),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
  };

  const pending = judge(params(undefined), checkContext, async () => ({ type: "stub", runner: stub }));
  await running;
  controller.abort();
  const results = await pending;
  assert.equal(results[0]?.status, "pass");
  assert.ok(stops.length >= 1, "the abort handler did not stop the runner");
});

test("an already cancelled run never starts the judge's runner", async (t) => {
  const dirs = await setup(t);
  const starts: string[] = [];
  let stops = 0;
  const stub: Runner = {
    run: async () => {
      starts.push("run");
      return { finalText: '{"criteria":[{"pass":true,"reason":"ok"}]}', diagnostics: [] };
    },
    stop: async () => {
      stops += 1;
    },
  };
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    judge(
      params(undefined),
      { ...(await context(dirs.root, dirs.workspace, dirs.baseline)), signal: controller.signal },
      async () => ({
        type: "stub",
        runner: stub,
      }),
    ),
    (error: unknown) => error instanceof JudgeError && /cancelled before its runner started/.test(error.message),
  );
  assert.deepEqual(starts, []);
  assert.equal(stops, 0);
});

test("a cancellation during HOME preparation does not launch the runner either", async (t) => {
  const dirs = await setup(t);
  const starts: string[] = [];
  const controller = new AbortController();
  const stub: Runner = {
    prepareHome: async () => {
      controller.abort();
      return [];
    },
    run: async () => {
      starts.push("run");
      return { finalText: '{"criteria":[{"pass":true,"reason":"ok"}]}', diagnostics: [] };
    },
    stop: async () => {},
  };

  await assert.rejects(
    judge(
      params(undefined),
      { ...(await context(dirs.root, dirs.workspace, dirs.baseline)), signal: controller.signal },
      async () => ({ type: "stub", runner: stub }),
    ),
    (error: unknown) => error instanceof JudgeError && /cancelled before its runner started/.test(error.message),
  );
  assert.deepEqual(starts, []);
});

test("judge rejects invalid parameters before launch", async (t) => {
  await setup(t);
  const parse = (value: ImplementationParams) =>
    parseImplementationParams(judgeChecker.params, value, 'checker "judge"');

  await assert.rejects(() => parse({ files: ["hello.txt"], rubric: [] }), ConfigError);
  await assert.rejects(() => parse({ files: [], rubric: ["x"] }), ConfigError);
  await assert.rejects(() => parse({ files: ["/etc/passwd"], rubric: ["x"] }), ConfigError);
  await assert.rejects(() => parse({ files: ["~/"], rubric: ["x"] }), /not HOME itself/);
  await assert.rejects(() => parse({ files: ["~/."], rubric: ["x"] }), /not HOME itself/);
  await assert.rejects(() => parse({ file: "hello.txt", rubric: ["x"] }), ConfigError);
  await assert.rejects(() => parse({ files: ["hello.txt"], rubric: ["x"], extra: 1 }), ConfigError);
  await assert.rejects(() => parse({ rubric: ["x"] }), /needs files, trace or both/);
  await assert.rejects(() => parse({ files: ["hello.txt"], trace: false, rubric: ["x"] }), ConfigError);
  await assert.rejects(
    () => parse({ files: ["hello.txt"], rubric: ["x"], runner: { model: "p/m" } }),
    /must name the runner "\$type"/,
  );
  await assert.rejects(() => parse({ files: ["hello.txt"], rubric: [""] }), ConfigError);
  assert.deepEqual((await parse({ files: ["trace.md"], trace: true, rubric: ["x"] })).files, ["trace.md"]);
});

test("judge rejects ~/ paths when the runner does not support HOME", async () => {
  await assert.rejects(
    () =>
      prepare(
        { files: ["~/notes/a.md"], rubric: ["ok"] },
        async () => ({
          type: "stub",
          runner: { run: async () => ({ finalText: "", diagnostics: [] }), stop: async () => {} },
        }),
        { runnerSupportsHome: false },
      ),
    (error: unknown) => error instanceof ConfigError && /HOME/.test(error.message),
  );
});

test("judge stages multiple workspace files, directories, globs, ~/ files, and trace without collision", async (t) => {
  const dirs = await setup(t, "root-hello\n");
  await mkdir(join(dirs.workspace, "docs", "nested"), { recursive: true });
  await writeFile(join(dirs.workspace, "docs", "a.md"), "doc-a\n");
  await writeFile(join(dirs.workspace, "docs", "nested", "b.md"), "doc-b\n");
  await writeFile(join(dirs.workspace, "docs", "skip.txt"), "ignored-txt\n");
  await writeFile(join(dirs.workspace, "trace.md"), "workspace-trace-file\n");
  await mkdir(join(dirs.home, "vault", "plan"), { recursive: true });
  await writeFile(join(dirs.home, "vault", "plan", "index.md"), "vault-index\n");
  await writeFile(join(dirs.home, "vault", "plan", "dev.md"), "vault-dev\n");

  const fake = await createFakePi(t, "judge-evidence");
  const results = await judge(
    {
      runner: piDeclaration(fake),
      files: ["trace.md", "docs/**/*.md", "docs/a.md", "~/vault/plan"],
      trace: true,
      rubric: ["All evidence is present."],
    },
    {
      ...(await context(dirs.root, dirs.workspace, dirs.baseline)),
      trace: [{ type: "message", text: "trace-message" }],
    },
    createDeclaredRunner,
    { runnerSupportsHome: true },
  );

  const reason = results[0]?.reason ?? "";
  assert.match(reason, /home\/vault\/plan\/dev\.md=vault-dev/);
  assert.match(reason, /home\/vault\/plan\/index\.md=vault-index/);
  assert.match(reason, /trace\.md=\[1\] message/);
  assert.match(reason, /workspace\/docs\/a\.md=doc-a/);
  assert.match(reason, /workspace\/docs\/nested\/b\.md=doc-b/);
  assert.match(reason, /workspace\/trace\.md=workspace-trace-file/);
  assert.doesNotMatch(reason, /skip\.txt/);
});

test("unmatched globs and empty directories are reported in the prompt rather than erroring", async (t) => {
  const dirs = await setup(t, null);
  await mkdir(join(dirs.workspace, "empty-dir"));
  const fake = await createFakePi(t, "judge-echo");

  const results = await judge(
    {
      runner: piDeclaration(fake),
      files: ["docs/*.md", "empty-dir"],
      rubric: ["Missing files noted."],
    },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  const prompt = results[0]?.reason ?? "";
  assert.match(prompt, /docs\/\*\.md: no files matched this pattern/);
  assert.match(prompt, /workspace\/empty-dir: an empty directory/);
});

test("judge refuses explicit protected HOME paths and identities, and skips them in globs and directories", async (t) => {
  const dirs = await setup(t, null);
  await mkdir(join(dirs.home, ".pi", "agent"), { recursive: true });
  const secretPath = join(dirs.home, ".pi", "agent", "auth.json");
  await writeFile(secretPath, '{"token":"super-secret"}\n');
  await writeFile(join(dirs.home, ".pi", "agent", "public.txt"), "public-ok\n");
  await symlink(secretPath, join(dirs.home, ".pi", "agent", "link.json"));
  const hardlinkPath = join(dirs.workspace, "leaked.json");
  await link(secretPath, hardlinkPath);

  const secretId = fileIdentity(await lstat(secretPath, { bigint: true }));
  const protectedHome: HomeProtection = {
    paths: [".pi/agent/auth.json"],
    identities: [secretId],
  };
  const checkContext = await context(dirs.root, dirs.workspace, dirs.baseline, { protectedHome });
  const fake = await createFakePi(t, "judge-evidence");

  // Explicit protected path is rejected.
  await assert.rejects(
    judge(
      { runner: piDeclaration(fake), files: ["~/.pi/agent/auth.json"], rubric: ["ok"] },
      checkContext,
      createDeclaredRunner,
      { runnerSupportsHome: true },
    ),
    (error: unknown) => error instanceof JudgeError && /refusing to stage protected file/.test(error.message),
  );

  // Explicit hardlink in workspace sharing a protected identity is rejected.
  await assert.rejects(
    judge({ runner: piDeclaration(fake), files: ["leaked.json"], rubric: ["ok"] }, checkContext, createDeclaredRunner, {
      runnerSupportsHome: true,
    }),
    (error: unknown) => error instanceof JudgeError && /refusing to stage protected file/.test(error.message),
  );

  // Glob and directory traversal skip protected paths, protected identities, and symlinks.
  const results = await judge(
    { runner: piDeclaration(fake), files: ["~/.pi/**", "**"], rubric: ["ok"] },
    checkContext,
    createDeclaredRunner,
    { runnerSupportsHome: true },
  );
  const reason = results[0]?.reason ?? "";
  assert.match(reason, /home\/\.pi\/agent\/public\.txt=public-ok/);
  assert.doesNotMatch(reason, /super-secret/);
  assert.doesNotMatch(reason, /auth\.json/);
  assert.doesNotMatch(reason, /link\.json/);
  assert.doesNotMatch(reason, /leaked\.json/);
});
