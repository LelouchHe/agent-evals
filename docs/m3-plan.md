# M3: Controlled Collaborators

Status: planned. Mocks and interaction checks moved out of [M2](m2-plan.md) into this milestone so M2 closes cleanly on ACP execution and trace evidence. Nothing here is implemented yet; syntax below records agreed structure where settled and leaves matching grammar open.

## Scope

Replace or observe external collaborators at the environment boundary, record every call that reaches them outside the sandbox, and assert on those records through deterministic checks.

1. **Shell collaborators.** Intercept `PATH` programs and workspace scripts through thin forwarders, run mock actions or delegate to the real target, and retain structured interaction records.
2. **Deterministic call checker.** Assert on recorded interactions through an ordinary `$type` checker without engine assertion magic.
3. **MCP collaborators.** Inject mock MCP servers through ACP `session/new` over the same host channel and interaction log.

Not in scope: harness-internal tools (`Read`, `Edit`, `WebFetch` and similar built-ins), shell builtins (`cd`, `export`), HTTP/network interception, model-provider fault injection, Linux.

## Decisions

- **Mocks live at the environment boundary, not in ACP.** ACP session updates are reports rather than interception hooks, and harness-native tool schemas vary across harnesses. Process questions over internal tools belong to a judge reading `trace.json`; deterministic call evidence comes from boundary mocks.
- **Behavior and interaction records stay outside the sandbox.** Inside the sandbox, a mock is only a thin forwarder to the engine host; mock handlers, static responses and call logs live outside everything the agent can read or write. Mocks are not assumed undetectable (`which`, reading the forwarder or a denied direct exec can still reveal substitution), so the goal is unforgeable records and hidden mock logic rather than stealth.
- **Arrange (`mocks`) and Assert (`checks`) are separate.** Top-level `mocks` owns runtime interception, actions and call recording (like gMock `ON_CALL`) and never produces pass/fail judgments; `checks` inspects recorded interactions after the run (like `EXPECT_CALL`). Shared `mocks` can be reused across named cases with different inputs or checks.
- **Stub, fake and spy are three actions of one mechanism.** Every call reaching a declared mock is recorded before its action runs:
  - `return`: fixed `exitCode`, `stdout` and `stderr` (stub).
  - `run`: invoke an author-supplied host program with the call's arguments and return its output and exit code (fake; trusted authoring code, like extensions).
  - `pass`: delegate to the real executable or script inside the sandbox so real execution never escapes Seatbelt (spy).
- **Ordered per-target rules, fail closed when unmatched.** A target takes one rule or an ordered list of rules; the first matching rule wins, and a rule without a condition acts as the fallback. When no rule matches, the call is still recorded and returns a non-zero exit status rather than implicitly running the real command.
- **Seatbelt denial follows `pass`.** When no rule for a `PATH` target uses `pass`, Seatbelt denies executing the resolved real binary by absolute path; when `pass` is present, the real path stays executable so the forwarder can run it in-sandbox, which means `pass` can prove a command was called with given arguments through `PATH` but cannot prove absence against direct absolute-path execution.
- **Shell targets cover both `PATH` commands and workspace scripts.** Under `mocks.shell`, a bare name (such as `make` or `git`) places a forwarder in a per-run directory ahead of `home.path`; a workspace-relative path (such as `scripts/deploy.sh` or a skill script) places the forwarder at that workspace path while keeping any real script outside the agent's reach unless `pass` invokes it.
- **Runners without mock support fail at load time.** Running a case that declares `mocks` on a runner that cannot wire them (such as the native `pi` runner) is a `ConfigError`, never a silent run against real commands.
- **Engine stays assertion-agnostic; `judge` is unchanged.** The engine exposes raw interaction records on `CheckerContext` and writes `interactions.json` beside `trace.json`. Checking lives in a replaceable `$type` checker; asserting on an unmocked target is a checker `error` rather than a vacuous pass. `judge` does not take `interactions` unless a real case later needs qualitative judgment over indirect script calls absent from `trace.json`.

### Agreed outer shape

```yaml
mocks:
  shell:
    make:
      return:
        exitCode: 1
        stderr: "deploy commands are disabled\n"
    scripts/deploy.sh:
      run: [sh, ./mocks/fake-deploy.sh]
    npm:
      pass: true
    git:
      - args: ... # argument-matching syntax still open
        return:
          exitCode: 0
          stdout: "Everything up-to-date\n"
      - pass: true
```

## Verified Constraints

From the M2 spikes on Pi 1.5.2 (`pi-acp` fork 0.0.34) and Claude Code 2.1.318 (`claude-agent-acp` 0.101.0) under macOS Seatbelt:

- **Command shim and Seatbelt deny:** a `PATH` shim for `make` ahead of `home.path` recorded both direct shell calls and calls made from inside a script in both harnesses; direct execution of `/usr/bin/make` by absolute path was denied by Seatbelt with exit code `126`. Needs nothing in `deps`.
- **MCP injection:** an MCP mock server injected through `session/new` was called through the harness tool in both harnesses; tool names surfaced as `mcp__<server>__<tool>` in both. Pi through `pi-acp` needed `_meta.directTools: true` on the injected server entry, and any `--tools` allowlist had to include `mcp__<server>__*`.
- **Observed agent probing:** during spikes, an unprompted agent listed its run directory, read mock logs and source, recognized the mocks and ran a mock server by hand, producing a false call record when logs lived inside the sandbox.

## Open Questions

- **Argument and value matching syntax (primary blocker).** How `args` in `mocks.shell` rules and parameters in the deterministic call checker express exact sequences, subcommand prefixes, unordered flags (including multi-token flags such as `--repo foo/bar`) and future structured MCP object inputs. Explored and rejected so far:
  - Plain regex over flattened argument strings: loses array/object structure and gives poor failure reasons.
  - Ad hoc container keywords (`prefix`, `contains`, `has`, `some`): feel patchwork or CLI-specific and collide with real object keys unless prefixed.
  - Anchored glob arrays (`*`, `**`) with `and` / `or` / `not`: clean for prefixes, but unordered flags require awkward `["**", "--flag", "**"]` wrappers.
  - Default-partial vs default-exact `$`-operator trees: neither felt natural enough yet.
- **Call checker `$type` name and schema.** Naming (`call` vs `interactions`), count constraints (`times: 0`, exact count, bounds) and whether one generic matcher checker later spans calls, JSON files and output or stays per-evidence-source first.
- **Sandbox-to-host transport and forwarder runtime.** Which IPC channel Seatbelt permits cleanly (per-run Unix domain socket vs localhost TCP) and what minimal runtime implements the in-sandbox forwarder cleanly (separating stdout, stderr and exit code without assuming Node is on `PATH`), plus whether stdin is forwarded or ignored initially.
- **Workspace-script mocks vs `file` `unchanged` checks.** Placing a forwarder at `scripts/deploy.sh` changes what sits in the workspace if not accounted for in baseline/workspace handling.
- **MCP mock configuration and spy behavior.** Exact `mocks.mcp` syntax, server naming and harness-specific `_meta` (such as Pi's `_meta.directTools: true`), whether MCP supports `pass` to a real server, and HTTP service mocks / model-provider fault injection (which depend on the deferred proxy).
