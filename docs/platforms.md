# Host Platforms

Agent Evals runs evaluations directly on the host OS under its native sandbox rather than standardizing on containers. All OS-specific sandboxing, process supervision, and path rules live under [`src/platform/`](../src/platform/), behind one `PlatformBackend` contract; the engine and runners stay platform-agnostic.

Every backend **fails closed** during preflight (`assertSandboxAvailable`) if the host cannot enforce the required sandbox boundary.

## Support Matrix

| Platform                             | Status                    | Backend                                                            | Requirements                                                                                                                                          |
| ------------------------------------ | ------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS** (`darwin`)                 | Supported                 | Seatbelt (`/usr/bin/sandbox-exec`)                                 | macOS with `sandbox-exec`, Node.js 24+                                                                                                                |
| **Linux** (`linux`, `x64` / `arm64`) | Supported                 | `bubblewrap` (`bwrap`) + seccomp-bpf                               | `bubblewrap`, `util-linux` (`script` for interactive TTY), unprivileged user namespaces enabled, Node.js 24+                                          |
| **Windows — WSL2**                   | Supported (same as Linux) | Linux `bubblewrap` backend                                         | WSL2 Linux kernel with `bubblewrap` and Node.js 24+; keep checkouts and `TMPDIR` on the native Linux filesystem (`~/`, `/tmp`), not `/mnt/c`          |
| **Windows — native** (`win32`)       | Supported                 | Dedicated sandbox users + Restricted Token + Job Object + Firewall | Windows 10/11 or Server, `win-sandbox.exe` (`native/win-sandbox`), one-time Admin `agent-evals setup sandbox`, Node.js 24+, PowerShell 7 (`pwsh.exe`) |
| **Windows — WSL1**                   | Unsupported               | —                                                                  | Lacks Linux namespaces and seccomp; fails closed during preflight                                                                                     |

## macOS (`src/platform/macos/`)

- **Sandbox:** Generates a deny-default Seatbelt (`.sb`) profile executed via `/usr/bin/sandbox-exec`.
- **Filesystem:** Allows read-only access to macOS system roots (`/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/private/etc`, `/dev`, timezone/TLS metadata) plus declared `readableRoots`/`readableFiles`; writes are restricted to run-owned `writableRoots`/`writableFiles` and `/dev/null`. Check sandboxes (`readAll: true`) open host reads while keeping write and network denials.
- **Process cleanup:** Wraps supervised workloads in `supervisor.sh`, which uses Seatbelt's `(allow signal (target same-sandbox))` rule to broadcast `kill -KILL -- -1` on exit or stop, terminating backgrounded and new-session descendants while isolating other sandboxes and host processes.
- **Interactive TTY:** Detects the controlling terminal via `/usr/bin/tty` and permits only termios `file-ioctl` operations (`TIOCSETA*`) on that terminal device.
- **Network & mocks:** `allowNetwork: true` enables `network-outbound` and macOS TLS trust `mach-lookup` services; `allowNetwork: false` omits all network rules. Mocked no-pass commands are denied via `(deny process-exec ...)`, including binaries resolved through `/usr/bin/xcode-select -p` for macOS toolchain shims.

## Linux & WSL2 (`src/platform/linux/`)

- **Preflight:** Resolves `bwrap` to a canonical absolute executable path and runs a live probe (`bwrap --ro-bind / / --unshare-pid --die-with-parent --new-session -- /usr/bin/true`). If `bwrap` is missing or unprivileged user namespaces are blocked (for example by kernel sysctl or AppArmor), startup fails closed with diagnostics.
- **Filesystem & DNS:** Constructs a minimal read-only mount namespace (`/usr`, `/etc`, `/dev`, `/proc`, plus distro-aware `/bin`, `/sbin`, `/lib`, `/lib64` symlinks or directories) overlaid with declared `readableRoots`/`readableFiles` and writable `--bind` mounts. When `allowNetwork: true`, multi-hop resolver symlinks (such as `systemd-resolved`, OrbStack, or WSL2's `/etc/resolv.conf -> /mnt/wsl/resolv.conf`) are resolved to their first unmounted hop so DNS works inside the read-only `/etc` bind. Check sandboxes (`readAll: true`) mount `--ro-bind / /` with `--dev /dev --proc /proc` and writable overlays.
- **Credentials & environment:** Host launchers (`bwrap`, `script`) start with a minimal trusted environment. The workload's environment is injected inside the sandbox via `bwrap --args` (FD 3, `--clearenv`/`--setenv`) from an exclusively created file that is opened and immediately unlinked before `spawn`, so expanded credentials never appear on argv or remain on disk. Embedded NUL bytes in environment keys/values are rejected.
- **Process cleanup:** Runs every sandbox with `--unshare-pid --die-with-parent`. When the workload exits or `bwrap` stops, the Linux kernel tears down the PID namespace and sends `SIGKILL` to every descendant automatically.
- **Interactive TTY:** Non-interactive runs pass `--new-session`. Interactive runs on a real TTY allocate a sandbox-owned PTY via `/usr/bin/script` so `/dev/tty` works without exposing the operator's terminal to `TIOCSTI`, with a 2.5s `SIGTERM` grace period so `script` restores host termios cleanly.
- **Network, IPC & mocks:** `allowNetwork: false` combines `--unshare-net` with a cBPF seccomp filter (`--seccomp`, FD 4) that denies `socket(2)`, `connect(2)`, `io_uring_setup(2)`, and `x86_64` x32 ABI syscalls with `EPERM`, blocking both TCP/UDP and pathname/abstract `AF_UNIX` sockets across the entire filesystem while preserving open reads for ordinary files. Mocked no-pass executables are masked with `--ro-bind /dev/null <target>`.

### WSL2 Notes

WSL2 runs a real Linux kernel and uses the Linux `bubblewrap` backend without modification. Two practical requirements apply:

1. Use **WSL2** (WSL1 lacks Linux namespaces and seccomp and will fail preflight).
2. Keep repositories, agent `deps`, and `TMPDIR` on the WSL2 Linux filesystem (`~/`, `/tmp`) rather than `/mnt/c` (Windows 9P mounts lack full POSIX permissions, symlink semantics, and Unix socket support).

## Native Windows (`src/platform/windows/`)

- **One-time setup (`agent-evals setup sandbox`):** Run once from an elevated Administrator prompt to execute the bundled `src/platform/windows/setup.ps1`, provisioning two low-privilege local accounts (`agent-evals-online` and `agent-evals-offline`), a Windows Defender Firewall outbound block rule scoped to `agent-evals-offline`'s SID, the shared run root `C:\ProgramData\agent-evals\runs`, and the credentials file at `%LOCALAPPDATA%\agent-evals\sandbox-users.json`. Run `agent-evals setup sandbox --teardown` as Administrator to remove all of them cleanly. No Administrator elevation is required at runtime.
- **Preflight:** Resolves `win-sandbox.exe` (via `AGENT_EVALS_WIN_SANDBOX_BIN` or `native/win-sandbox/target/{release,debug}/win-sandbox.exe`) and runs `win-sandbox.exe --probe <credentialsPath>` to verify the accounts and helper before starting any run.
- **Two-stage launch (`native/win-sandbox/`):**
  1. The outer process runs as the standard operator user, grants scoped NTFS ACEs to the sandbox user on `readableRoots`/`writableRoots`/`readableFiles`/`writableFiles`, creates 3 stdio Named Pipes (plus an optional `AGENT_EVALS_REPORT_PIPE` for check-runner reporting) with two-SID DACLs (`operator + sandboxUser`), attaches a Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), and starts `win-sandbox.exe --inner` via `CreateProcessWithLogonW`.
  2. The inner process runs as the sandbox user, derives a restricted token via `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED)` with the sandbox user SID in `SidsToRestrict`, and launches the workload via `CreateProcessAsUserW` (wrapping `.cmd`/`.bat` shims with `cmd.exe /d /c`). On exit or `stop()`, the outer process closes the Job Object (killing the full descendant tree) and revokes the granted NTFS ACEs.
- **Filesystem & environment:** Because the workload runs as a separate local account, the operator's real `%USERPROFILE%` is unreachable by default. Runs default to `C:\ProgramData\agent-evals\runs` (overridable via `AGENT_EVALS_WIN_RUNS_DIR`) so Node `realpathSync` does not traverse an unreadable operator temp directory. `SYSTEM_PATH` includes `System32`, `WindowsPowerShell\v1.0`, and PowerShell 7 (`C:\Program Files\PowerShell\7`), and the workload environment receives standard `ProgramFiles`/`ProgramData` defaults so Git Bash–based harnesses (`pi`, `claude`) locate Git Bash instead of WSL's `System32\bash.exe`.
- **Network & mocks:** `allowNetwork: false` launches under `agent-evals-offline`, whose outbound traffic is blocked by Windows Defender Firewall while loopback (`127.0.0.1`) remains available. Shell mocks listen on an authenticated loopback TCP endpoint (`tcp://127.0.0.1:<port>/<128-bit-nonce>`) and place both `.cmd` and extensionless `sh` companion shims in the mock `PATH` directory so `cmd.exe`, PowerShell, and Git Bash all intercept mocked commands consistently.

### Why Dedicated Sandbox Users (Evaluated Alternatives)

Before settling on dedicated local sandbox users, two other Win32 isolation primitives were prototyped and tested end-to-end on `windows-latest`:

| Approach                                       | Prototype                                         | Outcome                      | Root Cause                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AppContainer**                               | `poc/windows-appcontainer` (#24)                  | Ruled out (7/8)              | Node.js 24/26 (`libuv 1.52.1`) deadlocks in `uv__pipe_server` (`CreateNamedPipeA("\\?\pipe\uv\...")` spin-loops on `ERROR_ACCESS_DENIED`: `libuv/libuv#5178`, `nodejs/node#66374`, `nodejs/node#66282`); `NUL` (`stdio: "ignore"`) returns `EPERM`; Mount Manager / `realpathSync` calls fail (`microsoft/mxc#1464`, `#1706`).   |
| **Unelevated Restricted Token**                | `poc/windows-restricted-token` (#25)              | Ruled out (4/7)              | `libuv` `stdio: "pipe"` fails immediately with `spawn EPERM` because `npfs.sys` assigns `CREATOR OWNER (<UserSID>)` on default named pipes and `<UserSID>` cannot be added to `SidsToRestrict` for the real operator account (same kernel limit as `openai/codex#47868`), plus no unprivileged per-token outbound network block. |
| **Dedicated sandbox users + Restricted Token** | `poc/windows-sandbox-user` (#26 → shipped in #27) | **Shipped (9/9 + live ACP)** | Placing `sandboxUserSid` in `SidsToRestrict` satisfies `npfs.sys` `CREATOR OWNER` (`stdio: "pipe"`, `git`, `pwsh`, Git Bash, Node 24 all work), isolates `%USERPROFILE%`, supports per-SID Firewall offline blocking, and needs no Admin elevation at runtime.                                                                   |

## Adding a New Platform

Implement `PlatformBackend` (`src/platform/types.ts`) under `src/platform/<os>/`, register it in `src/platform/index.ts`, add the platform to `package.json` (`os`) and `.github/workflows/ci.yml`, and add platform-specific sandbox tests under `tests/<os>/` (wired in `scripts/test.mjs`). All OS-specific logic—including shell lookups, mock forwarder templates/endpoints, and check-runner reporting—must stay inside `src/platform/`.
