# M6: One Run Layout

Status: in progress — partly delivered. The run layout described here shipped; the rest of the roadmap's sandbox configuration item is [still to do](#remaining-in-m6), so this record stays outside the archive until M6 is complete. [M2](archive/m2-plan.md) built the isolated `HOME`, generic ACP runner and the `config`/`login` helpers; this milestone splits that `HOME` into a home, software, temporary space and engine-private state, and gives a case a way to supply user data.

The design below is what shipped. The interface section is the syntax the user approved; the placement and `view` shapes are as approved; the premise evidence is kept from the design stage, including the probe that used the old example `deps` layout (`deps/.local/bin`) — the examples now use the default `deps/bin`.

Every statement is labelled **decided** (agreed scope, implemented as stated), **approved** (the interface the user approved before implementation) or **verified** (measured on this machine during design or delivery).

## Why

A real sweep (12 routing cases × 3 runs, results in `/tmp/mw-routing-roster/`) showed what one run's layout cost before this milestone. Two failures were layout failures:

- **The run `HOME` was a mirror of the harness software.** `deps` was mirrored into `HOME` file by file as read-only symlinks: 20,967 files for Pi, 13,539 for Claude Code, 3 for Copilot CLI (measured: `find <deps> -type f | wc -l`). The agent's `PATH` entries were under `$HOME` (`$HOME/.local/bin` for the examples), so `which pi` answered a `HOME` path. There was no user data at all, and thousands of paths a user would never have were present.
- **A case could not put anything in `HOME`.** The routing case `q10` targets `~/mine/space`; it had to rewrite the prompt to point inside the workspace. In `q11` the agent ran `ls ~/mine/space` in all three runs and correctly found nothing, because the sweep had nothing to put there.

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
- Mirroring adds nothing. The software already executes from its real location, and the sandbox grants read access there.
- Resolving the link (`readlink run-xxxx/deps`) reveals the host path, and the symlink's targets remain host paths by construction.

**Verified constraint (implemented).** Seatbelt only authorizes traversal through the `deps` symlink when the run root and the link's target are spelled canonically. A run root under `/tmp/...` or a link whose target is `/tmp/...` is denied even though both the link path and the target's real path are allowed roots; the same layout with `/private/tmp/...` for both works. Minimal reproduction: a policy allowing `(subpath "/private/tmp/sbtest")` and a link `deps -> /tmp/sbtest/real` denies `ls deps/bin`; with the link target `/private/tmp/sbtest/real` and the query path `/private/tmp/.../deps/bin` it succeeds. The engine therefore chooses the run root under the canonical temporary parent (`realpath(tmpdir())`) and links `deps` to the canonical `deps` path, in both runs and the preparation helpers.

### 2. `HOME` is layered like the workspace — decided

- The agent file supplies `HOME`'s base — the harness settings — as a `files` map, copied at run start with the same placement code as a case's `files`.
- Its login state is copied in after that.
- A case overlays both with `files` entries whose destination starts with `~/`.
- A case entry may replace an agent-placed file (settings are an evaluation variable); it may never touch a login file.
- Simple cases without `~/` are unchanged.

**Approved change from the design probe.** The design proposed a prepared `home.base` directory. The approved interface removes it: the settings source sits beside the agent file and is the `files` mapping's value, so there is no intermediate tree to drift.

### 3. Ownership — decided

| Owner      | Owns                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Agent file | `deps`, `HOME` files, login, `environment`                                                                   |
| Case       | workspace and `~/` content (user data, user-level instructions and skills)                                   |
| Engine     | everything in `engine/`, denied by one rule, so anything the engine adds later is unreadable by construction |

### 4. Evidence reaches `HOME` — decided

The `file` checker accepts `~/` paths. The baseline covers the workspace plus what the case placed in `HOME`, not the harness's own sessions and caches. A `noop` run therefore still proves a `~/` assertion is vacuous or not.

### 5. Workspace stays a sibling of `HOME` — decided

No nesting. Nesting changes each harness's upward configuration lookup for little realism gain: a harness that walks `..` from its working directory would find `HOME`'s files, which is not what the evaluated user environment looks like.

### 6. Runners without a `HOME` — decided

`noop` and the native `pi` runner reject a case that uses `~/` — in `files` or in a `file` check — with a configuration error, the same way a case with `mocks` is rejected by a runner that does not declare mock support. The native Pi runner's own layout is not redesigned.

### 7. Not in M6 — decided

`shell` checks reading the run `HOME`; network restriction; per-harness host-service policy; a read-only attribute for placed files. Their relation to the roadmap's broader M6 item is in [Relation to the Roadmap](#relation-to-the-roadmap).

### 8. `.agentevalsignore` applies to `~/` placement — decided

A `~/` entry is an authoring copy like the fixture, `files` and check-time `files`: the same staging, the same ignore tree, the same collision rules within its destination root. It is not a second copy mechanism.

## The Agent File — approved

One file describes a harness for both the helpers and the runner. There is no `home` key and no compatibility with the old syntax.

```yaml
acpCommand: [pi-acp]
environment: {} # optional, unchanged
deps: ${env:PI_DEPS} # required: read-only software, linked as run-xxxx/deps
path: [bin] # optional, deps-relative command directories; default [bin]
files: # optional: what the agent file puts into HOME
  ~/.pi/agent/settings.json: pi-settings.json
login: # optional: the whole login concept in one place
  command: [pi]
  dir: ${env:PI_LOGIN}
  files: [.pi/agent/auth.json]
```

| Field         | Rule                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acpCommand`  | Required non-empty argv for the ACP entry point.                                                                                                                                              |
| `environment` | Optional extra variables; `HOME`, `TMPDIR`, `PATH` and `TERM` stay engine-set.                                                                                                                |
| `deps`        | Required caller-prepared software directory, linked once at the run root.                                                                                                                     |
| `path`        | Optional `deps`-relative command directories, default `[bin]`; `PATH` is those under `run-xxxx/deps/`, then the system directories.                                                           |
| `files`       | Optional `~/` destination → authoring source relative to the agent file, copied into HOME before login and the case overlay. A destination must start with `~/`; `.agentevalsignore` applies. |
| `login`       | Optional: `command` for the login helper, `dir` the persistent directory (it may be missing before the first login), `files` the HOME-relative composition (non-empty).                       |

`login.files` is the whole composition: only those files are copied into HOME and only those are saved back. A declared file that does not exist in a first-login directory is skipped. During a run or a `config` query, an existing login file the harness changes is copied back after the sandbox stops; a declared file the harness creates for the first time is saved only by the explicit `login` helper after its native command succeeds.

The three examples and their setup scripts use this syntax. Each script prepares software only, under `deps/{bin,share}`, and an empty `login/`; the settings file stays beside the agent file.

**Migration is required.** A prepared directory from before this milestone keeps its software but is not a settings source any more; re-run the setup script and move the settings into the agent file's `files` as [Setup](setup.md#migrating-from-the-prepared-home-layout) describes.

## Collision Rules — approved

All are load-time configuration errors except the two placement-time rules, which fail before the harness starts.

| Pair                                                    | Rule                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Agent `files` vs login file                             | **Error**, directly or through a directory source's contents. Checked when the agent file resolves, before any run resource. |
| Case `~/` entry vs login file                           | **Error**, always, directly or through a directory source's contents. Checked when every selected case is validated.         |
| Case `~/` entry vs agent **file**                       | Allowed: the case replaces it. This is the "settings are an evaluation variable" case.                                       |
| Case `~/` entry vs agent **directory**                  | Allowed: directories merge, exactly as `files` entries merge over the fixture.                                               |
| Two case `~/` entries producing one file                | **Error** during placement, as two workspace entries producing one file.                                                     |
| File vs directory at one path                           | **Error** during placement, whether the conflict comes from the agent file, the login state or another entry.                |
| `~/` destination that is `.`, absolute or contains `..` | **Error**. `~/` alone names HOME itself, which is a valid directory destination.                                             |

Application order is agent `files` → login files → the case's `~/` entries. The case runs last so it can replace agent files; login is copied before it, and the validator plus the placement guard are what forbid case/login collisions.

The declared spelling is not the only test. The filesystem decides whether a placement lands on login state, so placement also compares the identity (`dev:ino`) of what already exists at each target with the login files copied into HOME. A differently-cased or otherwise normalised spelling that the filesystem treats as one path is refused before anything is written, and login copy-back never sees changed bytes. On a case-sensitive filesystem the two spellings are different files, so nothing is written through the login file and the persistent directory is untouched.

## `view` — approved

`view` gained a `placement:` section after the field origins: one line per case-level entry — `fixture <dir>`, `files "<destination>"`, `home "<~/destination>"` — with counts, and `--files` lists every placed path with its authoring source and every exclusion with the deciding `.agentevalsignore` (its directory). An excluded directory is one line without its contents, and the ignore file itself is not listed. The dry run uses the same traversal, ignore answers and collision-free staging order as a run; the agent file's HOME content is not shown, because it is the runner's. `view` still requires `--case` for a multi-case document and starts no runtime.

## What Shipped

- **Run layout.** `prepareEvaluation` canonicalizes the run root and binds `home/`, `workspace/`, `tmp/`, `mocks/`, `engine/`; `engine/baseline/{workspace,home}` holds the two snapshots, `engine/check-*` the check sandboxes, `engine/replaced/` the real workspace scripts a mock moved out of reach, and `engine/forward` the forwarder template. The mock fixture directory is `mocks/`, first on `PATH` and readable, never writable. The policy file is `engine/sandbox.sb`.
- **Runner HOME step.** `Runner.prepareHome` places runner-owned HOME content before the case overlay and returns the login files the case may not touch; `Runner.homeFiles` exposes the same list at load time; `RunnerDefinition.home: true` declares the capability.
- **Agent file.** `deps`, `path`, `files`, `login { command, dir, files }`; the login helper uses `login.command`; `config` and `login` build the same layout as a run.
- **Case `~/` placement.** `files` destinations under `~/`, the `file` checker's `~/` paths, the HOME baseline, and the `noop`/native-`pi` rejection.
- **Trace.** `skillConsultations` takes workspace and HOME plus both baselines; it recognizes `~/` and absolute HOME paths and names a placed skill from the HOME baseline. Shell access follows the same resolution and stays uncounted.
- **`view`.** Placement counts and `--files`, computed by the engine's placement walk.
- **Docs.** README, configuration, setup, architecture, cases, mocks, extensions and roadmap describe the shipped behaviour; the consistency pass is reported with the delivery.

One implementation detail beyond the design text: a case `~/` entry that would place a login file — directly or through a directory source's contents — is rejected at load from the runner's declared `homeFiles`; agent `files` sources are read when the agent file resolves, so a missing source or a login-file collision there is also found before any selected case runs. Two case entries normalizing to one path and a file-versus-directory conflict are detected while staging, which is also when a workspace `files` collision is detected. Placement additionally refuses any target whose filesystem identity is a login file, which covers spellings the load-time comparison does not normalise.

## Verified at Delivery

- **Gates.** `npm run check` passes (323 tests, including the new layout, HOME placement, trace, file-check and `view` tests) and `npm run test:package` passes (1 test). Every commit ran the pre-commit lint/format hook.
- **Review follow-up.** A review of the range found that a differently-cased login path could be overwritten and persisted, and that later cases' HOME placement errors were found only when they ran. Placement now compares filesystem identity against the login files in HOME, and the load step reads agent `files` and walks case `~/` trees so a login-file collision or a missing agent source is a configuration error before any selected case runs.
- **Free evidence, from the built CLI.** `agent-evals config` answered for all three example agent files with software under the new `deps` and the run layout in place. A model-free ACP runner test shows a run whose `PATH` starts with `run-xxxx/deps/bin`, whose `which agent` is a run-root path, whose `home/`, `workspace/` and `tmp/` writes succeed, whose `deps` write and `engine/` read are denied, and whose HOME holds only the agent placement and harness-written state. Placement tests cover the case replacing an agent file, `file` `~/` paths with `changed: false`, a HOME-root placement, `.agentevalsignore` under `~/`, all collision rules, and the `noop` rejection. `view` on the routing document's q10 reports `files ".agents/skills": 72 placed, 17 excluded` and `home "~/mine/space": 1 placed, 0 excluded`; `--files` names the vault source and the deciding ignore files.
- **Paid runs** (authorized budget): `deploy-runbook` once per harness and routing q10 once.

| Run                                 | Status                                                     | Runner    | Duration | Reported cost                           |
| ----------------------------------- | ---------------------------------------------------------- | --------- | -------- | --------------------------------------- |
| deploy-runbook `pi-with-skill`      | pass (13/13 checks)                                        | completed | 23.6 s   | none reported by the installed `pi-acp` |
| deploy-runbook `claude-with-skill`  | pass (13/13)                                               | completed | 15.1 s   | 0.00334776 USD                          |
| deploy-runbook `copilot-with-skill` | pass (13/13)                                               | completed | 29.6 s   | none reported (100,335 tokens)          |
| routing q10 (Pi)                    | fail (knowledge-base loaded, markdown-writing also loaded) | completed | 35.1 s   | none reported                           |

Two earlier `pi-with-skill` attempts ended as `error` with every deterministic check passing and both judges failing `getaddrinfo ENOTFOUND`. The cause was pre-existing and outside this milestone's layout: the native Pi sandbox policy (shared with the judge) denied the `/etc` and `/var` literals libc stats before falling back to `resolv.conf`. Allowing those literal reads, as the ACP policy already does, fixed it; the runs above used the fixed build.

The q10 trace shows the agent `cd ~/mine/space` in the shell and read the vault's `index.md` there, then stopped to ask for the owning project instead of writing; one `read` of the literal host path `/Users/lelouch/mine/space` was denied by the sandbox. It consulted knowledge-base and markdown-writing, so the negative check fails as it did in the pre-change sweep.

## Verified Premises

Each premise decided whether decision 1 was workable. The probe assembled the proposed layout by hand under `/private/tmp/m6-premise/runs/<harness>/`, copied the settings file from a clone of `deps` into `home/`, copied the declared login files, linked `deps` to the clone, granted the sandbox the proposed roots, and spoke ACP `initialize` + `session/new` with the real adapter. It was the same session work `agent-evals config` does, so it started each harness and listed its options without prompting a model. The probe used the then-current example layout (`deps/.local/bin`); the delivered examples use `deps/bin` and the same probe shape was re-run after delivery through `agent-evals config`.

### 1. All three harnesses start with software outside `HOME`, `PATH` through the symlink — verified

| Harness                                                    | `command -v <adapter>` inside the sandbox                              | ACP result                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pi (`pi-acp`, Node install)                                | `/private/tmp/m6-premise/runs/pi/deps/.local/bin/pi-acp`               | `authMethods=pi_terminal_login configOptions=2 ids=model,thought_level`                     |
| Claude Code (`claude-agent-acp` + bundled `claude` binary) | `/private/tmp/m6-premise/runs/claude/deps/.local/bin/claude-agent-acp` | `authMethods=(none) configOptions=5 ids=mode,model,thought_level,model_config,model_config` |
| Copilot CLI (native Mach-O binary)                         | `/private/tmp/m6-premise/runs/copilot/deps/.local/bin/copilot`         | `authMethods=copilot-login configOptions=4 ids=mode,model,thought_level,permissions`        |

The Node-based install, the Node adapter that spawns a bundled platform binary, and the single native binary all resolved their own files through the link. The run-root path appeared in `command -v`. The same probe showed `echo > deps/CANARY` denied, `engine/sandbox.sb` unreadable, `home/`, `workspace/` and `tmp/` writable, and `readlink deps` revealing the host path.

### 2. Where Pi looks for `fd` and `rg` — verified

Pi's tool manager (`dist/utils/tools-manager.js` in `@earendil-works/pi-coding-agent`) checks `$PI_CODING_AGENT_DIR/bin` (default `~/.pi/agent/bin`) first, then runs `<cmd> --version` for `fd`, `fdfind`, `rg` on `PATH`; only when neither finds a tool does it download into the tools directory. A prepared `fd`/`rg` is software and belongs in `deps` (visible through the `PATH` link); Pi's own downloads land in `HOME` and disappear with the run. Neither belongs in the agent file's HOME `files`.

### 3. Does a harness write its settings or other base files? — verified

A hash snapshot of `home/` before and after the session, with `settings.json` copied as the agent file's `files`:

| Harness     | Base settings                                                                  | Other HOME writes                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi          | unchanged                                                                      | new `.pi/agent/models-store.json`, `.pi/pi-acp/session-map.json`, `.npm/` cache and log, Node compile cache under `tmp/`                                                                                                     |
| Claude Code | unchanged                                                                      | new `.claude/cache/`, `.claude/plugins/store/`, `.claude/policy-limits.json*`, `.claude/remote-settings.json*`, `.claude/sessions/`; `tmp/claude-501/`                                                                       |
| Copilot CLI | **rewritten** (same values, reformatted); a new `settings.json.lock` beside it | `config.json` (login) rewritten with new fields; `.copilot/logs/`, `.copilot/session-state/`, `Library/Caches/copilot/` including a full package extraction, `Library/Application Support/Microsoft/DeveloperTools/deviceid` |

So the HOME base must be copied, not linked: Copilot writes its settings file at startup, and a linked base would either fail the write or mutate the caller's `deps`. With a copy the write lands in `home/` and disappears with the run. The prepared `deps` in this checkout still matches the settings template byte for byte, so the old mirror was not silently mutating `deps`; it relied on the sandbox refusing the write through the link, which the copy removes as a concern.

### 4. Anything else a harness needs at a `HOME` path that comes from `deps`? — verified: nothing

For all three examples, `deps` held only software (`/.local/…` then, `bin/` and `share/` now) plus the one settings file, and login held only the declared login files. Everything else a harness needs under `HOME` it creates itself (the table above): caches, session state, model stores, extracted packages. None of it is configuration to preserve or evaluation input, and all of it lands in the writable `home/`, so a copied base loses nothing. One residue: `copilot/deps/.copilot/settings.json.lock` existed in the old prepared tree but is not needed as input (the probe generated its own); it is a run artifact that migration drops.

### Unverified at design time, and why

- **A full prompt run per harness under the new layout.** It needs paid model calls; delivery verified it with the example and routing runs reported in the delivery record.
- **`HOME`-placed `SKILL.md` in the `trace` derivation.** Delivered: the derivation reads the HOME baseline and resolves `~/` and absolute HOME paths; the shell scan follows.
- **Windows/Linux.** This milestone is macOS Seatbelt only, like the implementation.

## Relation to the Roadmap

**Decided framing.** The roadmap's [Sandbox configuration (M6)](roadmap.md#open-questions) item is broader than this milestone: it asks for one declared configuration of roots, host services and network, per-agent versus per-case ownership, and a mapping to other platforms. This milestone delivers the part that declaration attaches to — the run layout, its ownership split and one builder — and leaves the declaration itself, the network restriction, per-harness services, unifying the judge/check sandboxes and other platforms open. The roadmap records the split.

## Remaining in M6

- **Sandbox policy as a declaration.** Policy is still assembled by the ACP runner, the native Pi runner and the judge; the check sandbox keeps its fixed policy.
- **Network restriction.** Unchanged: harness runs have network, checks do not.
- **Per-harness host services.** Copilot's system-trust services remain folded into `allowNetwork` for all callers.
- **Read-only attribute for placed files.** Copies of case `~/` files are writable by the agent, like workspace copies.
- **`shell` checks reading the run HOME.** A shell check still sees the workspace, its private HOME and TMPDIR.
