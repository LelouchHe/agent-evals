# Host Platforms

Agent Evals runs evaluations directly on the host OS under its native sandbox rather than standardizing on containers. All OS-specific sandboxing, process supervision, and path rules live under [`src/platform/`](../src/platform/), behind one `PlatformBackend` contract; the engine and runners stay platform-agnostic.

Every backend **fails closed** during preflight (`assertSandboxAvailable`) if the host cannot enforce the required sandbox boundary.

## Support Matrix

| Platform                             | Status                    | Backend                              | Requirements                                                                                                                                 |
| ------------------------------------ | ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS** (`darwin`)                 | Supported                 | Seatbelt (`/usr/bin/sandbox-exec`)   | macOS with `sandbox-exec`, Node.js 24+                                                                                                       |
| **Linux** (`linux`, `x64` / `arm64`) | Supported                 | `bubblewrap` (`bwrap`) + seccomp-bpf | `bubblewrap`, `util-linux` (`script` for interactive TTY), unprivileged user namespaces enabled, Node.js 24+                                 |
| **Windows — WSL2**                   | Supported (same as Linux) | Linux `bubblewrap` backend           | WSL2 Linux kernel with `bubblewrap` and Node.js 24+; keep checkouts and `TMPDIR` on the native Linux filesystem (`~/`, `/tmp`), not `/mnt/c` |
| **Windows — native / WSL1**          | Unsupported               | —                                    | `package.json` declares `os: ["darwin", "linux"]`; native Windows and WSL1 fail closed                                                       |

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

## Adding a New Platform

Implement `PlatformBackend` (`src/platform/types.ts`) under `src/platform/<os>/`, register it in `src/platform/index.ts`, add the platform to `package.json` (`os`) and `.github/workflows/ci.yml`, and add sandbox boundary tests under `src/platform/<os>/`. Non-POSIX hosts (such as native Windows) will additionally need platform adapters for shell lookup commands (`env-source.ts`), `forwarder.sh`, `PATH` delimiters, and FD 5 reporting.
