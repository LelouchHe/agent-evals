# M6: One Run Layout

Status: proposed; the interface below awaits approval and nothing here is implemented. [M2](m2-plan.md) built the isolated `HOME`, generic ACP runner and the `config`/`login` helpers; this milestone splits that `HOME` into a home, software, temporary space and engine-private state, and gives a case a way to supply user data.

Every statement is labelled **decided** (carried from agreed scope; not reopened), **proposed** (needs approval before implementation) or **verified** (measured on this machine, with the command summarized). Evidence commands were run on 2026-11-16 on macOS with Node 24.22.2; no model call was made.

## Why

A real sweep (12 routing cases × 3 runs, results in `/tmp/mw-routing-roster/`) showed what one run's layout costs today. Two failures are layout failures:

- **The run `HOME` is a mirror of the harness software.** `deps` is mirrored into `HOME` file by file as read-only symlinks: 20,967 files for Pi, 13,539 for Claude Code, 3 for Copilot CLI (measured: `find <deps> -type f | wc -l`). The agent's `PATH` entries are under `$HOME` (`$HOME/.local/bin` for the three examples), so `which pi` answers a `HOME` path. There is no user data at all, and thousands of paths a user would never have are present.
- **A case cannot put anything in `HOME`.** The routing case `q10` targets `~/mine/space`; it had to rewrite the prompt to point inside the workspace. In `q11` the agent ran `ls ~/mine/space` in all three runs and correctly found nothing, because the sweep had nothing to put there.

The same sweep is the motivation for the two ergonomics changes that precede this milestone; they are already delivered and not part of this plan.

## Target Layout

**Decided.** One run is one directory:

```text
run-xxxx/
  home/        $HOME, agent-writable: looks like a user's home
  workspace/   cwd, agent-writable: fixture + files
  tmp/         TMPDIR, agent-writable
  mocks/       read-only to the agent: mock forwarders
  deps         a directory symlink to the caller-prepared deps; PATH points through it
  engine/      unreadable to the agent: baseline, check-file staging, mock call records
```

### 1. Harness software leaves `HOME` — decided

`deps` means read-only software only, referenced in place: one directory symlink at the run root, not a copy and not a mirror. The agent's `PATH` entries are under `run-xxxx/deps/…`, so `which pi` shows a run-root path. Reasons:

- `HOME` should look like a home; thousands of harness paths are not user state.
- Mirroring adds nothing. The software already executes from its real location, and the sandbox already grants read access there.
- It is acknowledged that resolving the link (`readlink run-xxxx/deps`) reveals the host path, and that the symlink's targets remain host paths by construction.

**Verified constraint (adjustment inside decision 1).** Seatbelt only authorizes traversal through the `deps` symlink when the run root and the link's target are spelled canonically. A run root under `/tmp/...` or a link whose target is `/tmp/...` is denied even though both the link path and the target's real path are allowed roots; the same layout with `/private/tmp/...` for both works. Minimal reproduction: a policy allowing `(subpath "/private/tmp/sbtest")` and a link `deps -> /tmp/sbtest/real` denies `ls deps/bin`; with the link target `/private/tmp/sbtest/real` and the query path `/private/tmp/.../deps/bin` it succeeds. Therefore stage 2 must (a) choose the run root under the canonical temporary parent (`realpath(tmpdir())`), and (b) create `deps` pointing at the canonical `home.deps` path the engine already resolves. No part of decision 1 changes; this is a required implementation detail, not a fallback.

### 2. `HOME` is layered like the workspace — decided

- The agent file supplies `HOME`'s base (harness settings — a handful of files) and the login files.
- The base is **copied**, not linked.
- A case overlays it with `files` entries whose destination starts with `~/`.
- A case entry may replace a base file (settings are an evaluation variable); it may never touch a login file.
- Simple cases without `~/` are unchanged.

### 3. Ownership — decided

| Owner      | Owns                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Agent file | `deps`, `HOME` base, login, `environment`                                                                    |
| Case       | workspace and `~/` content (user data, user-level instructions and skills)                                   |
| Engine     | everything in `engine/`, denied by one rule, so anything the engine adds later is unreadable by construction |

### 4. Evidence reaches `HOME` — decided

The `file` checker accepts `~/` paths. The baseline covers the workspace plus what the case placed in `HOME`, not the harness's own sessions and caches. A `noop` run therefore still proves a `~/` fixture assertion is vacuous or not.

### 5. Workspace stays a sibling of `HOME` — decided

No nesting. Nesting changes each harness's upward configuration lookup for little realism gain: a harness that walks `..` from its working directory would find `HOME`'s files, which is not what the evaluated user environment looks like.

### 6. Runners without a `HOME` — decided

`noop` and the native `pi` runner reject a case that uses `~/` with a configuration error, the same way a case with `mocks` is rejected by a runner that does not declare mock support. The native Pi runner's own layout is not redesigned.

### 7. Not in M6 — decided

`shell` checks reading the run `HOME`; network restriction; per-harness host-service policy; a read-only attribute for placed files. Their relation to the roadmap's broader M6 item is in [Relation to the Roadmap](#relation-to-the-roadmap).

### 8. `.agentevalsignore` applies to `~/` placement — decided

A `~/` entry is an authoring copy like the fixture, `files` and check-time `files`: the same staging, the same ignore tree, the same collision rules within its destination root. It is not a second copy mechanism.

## Proposed: Agent-File Syntax After the Split

**Proposed.** The smallest change to the vocabulary already in use is one new key under `home`; nothing is renamed.

```yaml
command: [pi]
acpCommand: [pi-acp]
environment: {} # unchanged
home:
  deps: ${env:PI_DEPS} # read-only software, linked once as run-xxxx/deps
  base: ${env:PI_BASE} # NEW: a directory laid out like HOME, copied into home/
  login: ${env:PI_LOGIN} # unchanged: persistent login state, copied
  path: [.local/bin] # unchanged spelling; now resolved under run-xxxx/deps/
login: # unchanged: HOME-relative files the login helper saves
  - .pi/agent/auth.json
```

| Field        | Proposed rule                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `home.deps`  | Required caller-prepared directory of software only, linked in place. Same safety checks as today (accessible directory, does not contain the run directory).                                                                                                  |
| `home.base`  | Required caller-prepared directory laid out like `HOME`; its regular files are copied into `home/` before login state. It may be empty. A missing directory, a non-regular entry, or a path that collides with a declared login file is a configuration error. |
| `home.login` | Unchanged.                                                                                                                                                                                                                                                     |
| `home.path`  | Unchanged list of `deps`-relative command directories; `PATH` is each entry under `run-xxxx/deps/`, then `/usr/bin:/bin:/usr/sbin:/sbin`, with the mock forwarder directory first when mocks are wired.                                                        |
| `login`      | Unchanged file list.                                                                                                                                                                                                                                           |

`home.base` is required rather than optional so an unmigrated agent file fails loudly instead of silently dropping the evaluation's harness settings. The alternative — optional, defaulting to an empty base — keeps old agent files loadable but makes settings disappear without a word; it is not proposed.

### The Three Example Agent Files

**Proposed** rewrites (comments elided here; the files keep theirs):

```yaml
# examples/agents/pi.yml — deps: software only; base: Pi's evaluation settings
command: [pi]
acpCommand: [pi-acp]
home:
  deps: ${env:PI_DEPS}
  base: ${env:PI_BASE}
  login: ${env:PI_LOGIN}
  path: [.local/bin]
login: [.pi/agent/auth.json]
```

```yaml
# examples/agents/claude.yml — deps: Node + adapter + bundled claude binary
command: [claude]
acpCommand: [claude-agent-acp]
environment:
  CLAUDE_CODE_OAUTH_TOKEN: ${env:CLAUDE_OAUTH_TOKEN}
  CLAUDE_CODE_TMPDIR: ${TMPDIR}
home:
  deps: ${env:CLAUDE_DEPS}
  base: ${env:CLAUDE_BASE}
  login: ${env:CLAUDE_LOGIN}
  path: [.local/bin]
login: [.claude.json]
```

```yaml
# examples/agents/copilot.yml — deps: the native binary; base: Copilot settings
command: [copilot, login]
acpCommand: [copilot, --acp, --context, long_context]
environment:
  COPILOT_ALLOW_ALL: "true"
  COPILOT_AUTO_UPDATE: "false"
  COPILOT_DISABLE_LOGIN_SHELL_ENV: "1"
  COPILOT_SYSTEM_PROXY: "0"
  COPILOT_TELEMETRY_DISABLED: "true"
home:
  deps: ${env:COPILOT_DEPS}
  base: ${env:COPILOT_BASE}
  login: ${env:COPILOT_LOGIN}
  path: [.local/bin]
login: [.copilot/config.json]
```

### What Each Setup Script Prepares

**Proposed.** Each script keeps its current target argument and adds `base/`:

| Harness     | `deps/` (software only)                                                              | `base/` (copied into HOME)                            | `login/` (copied, saved back)                       |
| ----------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------- |
| Pi          | Node 24, `pi`, `pi-acp` under `.local/`; optional prepared `fd`/`rg` in `.local/bin` | `.pi/agent/settings.json` from `pi-settings.json`     | `.pi/agent/auth.json` after `login`                 |
| Claude Code | Node 24, `claude-agent-acp`, its bundled `claude` binary                             | `.claude/settings.json` from `claude-settings.json`   | `.claude.json` (the one-year token stays in `.env`) |
| Copilot CLI | the standalone native `copilot` binary                                               | `.copilot/settings.json` from `copilot-settings.json` | `.copilot/config.json`                              |

Each prints its `*_DEPS`, `*_BASE` and `*_LOGIN` lines for `.env`. `.env.example` and [Setup](../setup.md#prepare-acp-harnesses) gain the `*_BASE` entries.

### Migration of Prepared Directories

**Proposed.** Migration is required: re-run each setup script, which moves the settings file out of `deps/` into `base/`. The engine does not read settings from `deps` after the split, so a stale prepared directory still validates as software but the harness starts with no evaluation settings. The plan does not migrate directories in place, copy between them, or detect the old arrangement; the failure is visible as a harness running with default settings, and the setup script's output says what to put in `.env`. The `settings.json.lock` currently inside `copilot/deps/.copilot/` is a run artifact (verified: a probe with a fresh HOME generated one next to its copied settings) and is not part of `base/`.

### `config` and `login` Helpers

**Proposed.** Both helpers build the same layout into their own temporary `run-xxxx/` directory: `home/`, `workspace/`, `tmp/`, `deps` link and `engine/` holding the Seatbelt policy. They have no baseline, checks or mock records, so the rest of `engine/` is simply absent. One engine-side builder creates the layout for the ACP runner and both helpers, so `config` proves the layout the runner will use.

## Proposed: Collision Rules

All are load-time configuration errors unless marked otherwise.

| Pair                                                      | Rule                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Base vs login (same HOME-relative path)                   | **Error**, as `deps` and login collide today. The two files would describe different bytes for one path. |
| Case `~/` entry vs base **file**                          | Allowed: the case replaces the base file. This is the "settings are an evaluation variable" case.        |
| Case `~/` entry vs base **directory**                     | Allowed: directories merge, exactly as `files` entries merge over the fixture.                           |
| Case `~/` entry vs login file                             | **Error**, always. A case may supply user data and user-level instructions, never login state.           |
| Two case `~/` entries producing one file                  | **Error**, as two workspace entries producing one file.                                                  |
| File vs directory at one `~/` path                        | **Error**, whether the conflict comes from the base or another entry.                                    |
| `~/` destination that is `.` or absolute or contains `..` | **Error**. `~/` alone names `HOME` itself, which is a directory destination like `.` for the workspace.  |
| Case `~/` path vs `deps`                                  | No rule: `deps` is not inside `HOME`. A base file under a `deps` `PATH` entry is pointless but harmless. |

Application order: base copy, then login copy, then the case overlay. The overlay runs last so a case can replace base files; login is copied before it so the validator, not the copy order, is what forbids case/login collisions.

## Proposed: `view`

**Proposed.** `view` gains a `placement:` section after `field origins:`, showing the entries that would be placed, without starting a runtime. `view` still requires `--case` for a multi-case document. The section is computed by dry-running the same traversal the run would use: the fixture, every `files` entry and every `~/` entry. Check-time `files` stay out of this page for now.

Default: one line per entry with placed and excluded counts. An excluded directory is one excluded path; its contents are not counted.

```text
placement:
  fixture fixture: 42 placed, 3 excluded
  files ".agents/skills": 402 placed, 12 excluded
  files "prompts/review.md": 1 placed
  home "~/.pi/agent/settings.json": 1 placed
  home "~/notes": 5 placed
```

`--files`: every placed path with its origin, and every excluded path with the ignore file responsible. Directories are listed as directories and their contents are omitted.

```text
placement:
  fixture fixture: 42 placed, 3 excluded
    place   .agents/skills/aw-retro/SKILL.md <- fixture/.agents/skills/aw-retro/SKILL.md
    place   notes.md <- fixture/notes.md
    exclude .agents/skills/aw-retro/evals (directory) <- .agentevalsignore at fixture/.agents/skills/aw-retro
  home "~/notes": 5 placed
    place   ~/notes/today.md <- notes/home/today.md
```

A path ignored by two files names the one whose answer decided it: the higher file. Within one file negation behaves as gitignore does, but a deeper file cannot re-include what a higher one excluded, as [Configuration](../configuration.md#fixture-and-files) already says.

Approval question: whether each exclusion names only the deciding ignore file (proposed) or every ignore file consulted.

## Proposed: Implementation Order for Stage 2

Each step is separately verifiable without a model call.

1. **Layout and builder.** One engine-side builder creates `home/`, `workspace/`, `tmp/`, `mocks/`, `engine/` and the `deps` link; the ACP runner uses it; the baseline and check staging move under `engine/`; mock forwarders and the `forward` script move under `mocks/`, `replaced/` and the forwarder fault marker join the engine-private state; the run root is canonical. Verify: the existing ACP, mock and check suites; `agent-evals config` for all three examples; a `noop` run of the worked example.
2. **Agent-file split.** `home.base` schema and copying; `home.path` resolved under `deps`; examples, setup scripts and `.env.example`; helpers share the builder. Verify: `config` and `login` for all three examples; a run whose `PATH` shows a `run-xxxx/deps/...` `which` result.
3. **`~/` placement.** Destination validation, base→login→case order, collision rules, ignore handling, baseline coverage, `file` `~/` paths, and the configuration error on `noop`/native `pi`. Verify: `noop` cases that place and check `~/` files, a `file` `changed: false` restraint over a placed `~/` file, and a case that fails only because the runner has no HOME.
4. **`view` placement.** Counts, then `--files`, over the same traversal. Verify: `view` on the worked example and on a fixture with a real `.agentevalsignore`.
5. **Documentation.** [Configuration](../configuration.md) (agent syntax, `~/` destinations, collision rules, `view`), [Setup](../setup.md) (prepared directories, migration, `*_BASE`), [Architecture](../architecture.md) (run-root diagram and the state table), [Writing Cases](../cases.md) (user data in HOME as an environment component), [Roadmap](../roadmap.md), and this archive entry's status when delivered.

A full prompt run per harness under the new layout is verification, not implementation order: it costs model calls and is not part of this stage's evidence.

## Verified Premises

Each premise decides whether decision 1 is workable. The probe assembles the proposed layout by hand under `/private/tmp/m6-premise/runs/<harness>/`, copies the settings file from a clone of `deps` into `home/`, copies the declared login files, links `deps` to the clone, grants the sandbox the proposed roots, and speaks ACP `initialize` + `session/new` with the real adapter. It is the same session work `agent-evals config` does, so it starts each harness and lists its options without prompting a model.

### 1. All three harnesses start with software outside `HOME`, `PATH` through the symlink — verified

| Harness                                                    | `command -v <adapter>` inside the sandbox                              | ACP result                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pi (`pi-acp`, Node install)                                | `/private/tmp/m6-premise/runs/pi/deps/.local/bin/pi-acp`               | `authMethods=pi_terminal_login configOptions=2 ids=model,thought_level`                     |
| Claude Code (`claude-agent-acp` + bundled `claude` binary) | `/private/tmp/m6-premise/runs/claude/deps/.local/bin/claude-agent-acp` | `authMethods=(none) configOptions=5 ids=mode,model,thought_level,model_config,model_config` |
| Copilot CLI (native Mach-O binary)                         | `/private/tmp/m6-premise/runs/copilot/deps/.local/bin/copilot`         | `authMethods=copilot-login configOptions=4 ids=mode,model,thought_level,permissions`        |

The Node-based install, the Node adapter that spawns a bundled platform binary, and the single native binary all resolve their own files through the link. The run-root path appears in `command -v`, as intended. The same probe also showed `echo > deps/CANARY` denied, `engine/sandbox.sb` unreadable, `home/` and `workspace/` writable, and `readlink deps` revealing the host path.

### 2. Where Pi looks for `fd` and `rg` — verified

Pi's tool manager (`dist/utils/tools-manager.js` in `@earendil-works/pi-coding-agent`) checks `$PI_CODING_AGENT_DIR/bin` (default `~/.pi/agent/bin`) first, then runs `<cmd> --version` for `fd`, `fdfind`, `rg` on `PATH`; only when neither finds a tool does it download into the tools directory. Conclusion: a _prepared_ `fd`/`rg` is software and belongs in `deps` (visible through the `PATH` link); Pi's own downloads land in `HOME` and disappear with the run. Neither belongs in the `HOME` base. The current [Setup](../setup.md#pi-piyml) advice to place them in `$PI_DEPS/.local/bin` remains correct under the split.

### 3. Does a harness write its settings or other base files? — verified

A hash snapshot of `home/` before and after the session, with `settings.json` copied as the base:

| Harness     | Base settings                                                                  | Other HOME writes                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi          | unchanged                                                                      | new `.pi/agent/models-store.json`, `.pi/pi-acp/session-map.json`, `.npm/` cache and log, Node compile cache under `tmp/`                                                                                                     |
| Claude Code | unchanged                                                                      | new `.claude/cache/`, `.claude/plugins/store/`, `.claude/policy-limits.json*`, `.claude/remote-settings.json*`, `.claude/sessions/`; `tmp/claude-501/`                                                                       |
| Copilot CLI | **rewritten** (same values, reformatted); a new `settings.json.lock` beside it | `config.json` (login) rewritten with new fields; `.copilot/logs/`, `.copilot/session-state/`, `Library/Caches/copilot/` including a full package extraction, `Library/Application Support/Microsoft/DeveloperTools/deviceid` |

So the base must be a copy, not a link: Copilot writes its settings file at startup, and a linked base would either fail the write or mutate the caller's `deps`. With a copy the write lands in `home/` and disappears with the run. The prepared `deps` in this checkout still matches the settings template byte for byte, so the current mirror is not silently mutating `deps`; it relies on the sandbox refusing the write through the link, which the copy removes as a concern.

### 4. Anything else a harness needs at a `HOME` path that comes from `deps`? — verified: nothing

For all three examples, `deps` holds only software (`/.local/…`) plus the one settings file, and login holds only the declared login files. Everything else a harness needs under `HOME` it creates itself (the table above): caches, session state, model stores, extracted packages. None of it is configuration to preserve or evaluation input, and all of it lands in the writable `home/`, so a copied base loses nothing. One residue: `copilot/deps/.copilot/settings.json.lock` exists today but is not needed as input (the probe generated its own) — it is a run artifact that migration drops.

### Unverified, and why

- **A full prompt run per harness under the new layout.** It needs paid model calls; the layout's effect on a turn is stage-2 verification.
- **`HOME`-placed `SKILL.md` in the `trace` derivation.** The shell-access derivation reads the baseline, which currently covers only the workspace; step 3 extends the baseline to case-placed `~/` files and the derivation's shell scan must follow. Decided scope, not this stage.
- **Windows/Linux.** This plan is macOS Seatbelt only, like the implementation.

## Proposed: What Stage 2 Does Not Deliver

- **Sandbox policy as a declaration.** The policy stays assembled by the ACP runner, the native Pi runner and the judge as it is today; the check sandbox keeps its fixed policy. This milestone gives those callers one run-layout builder, not one policy vocabulary.
- **Network restriction.** Unchanged: harness runs have network, checks do not.
- **Per-harness host services.** Copilot's system-trust services remain folded into `allowNetwork` for every caller.
- **Read-only attribute for placed files.** Copies of case `~/` files are writable by the agent, like workspace copies.

## Relation to the Roadmap

**Decided framing.** The roadmap's [Sandbox configuration (M6)](../roadmap.md#open-questions) item is broader than this plan: it asks for one declared configuration of roots, host services and network, per-agent versus per-case ownership, and a mapping to other platforms. This milestone delivers the part that declaration must attach to — the run layout, its ownership split and one builder — and explicitly leaves the declaration itself, the network restriction, per-harness services and other platforms open. The two remaining items in that roadmap entry that overlap the layout are the read-only attribute for placed copies and unifying the judge's and check sandboxes with the run's; neither is delivered here.

## Approval Questions

1. The agent-file split: `home.base` required, `home.path` reinterpreted as `deps`-relative, and the three rewritten examples.
2. The collision table, in particular "case replaces a base file" and "case never touches login".
3. The `view` placement shape, and whether `--files` names only the deciding ignore file per exclusion.
4. The implementation order in five separately verifiable steps.
