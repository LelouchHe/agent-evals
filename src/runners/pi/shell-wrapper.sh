#!/bin/sh
# Pi custom shell wrapper.
#
# Pi starts each bash tool invocation as a detached process-group leader. The
# wrapper keeps itself in that group but starts the requested shell in its own
# process group. After the shell exits, the wrapper kills the shell's group,
# which includes ordinary background jobs that outlived the shell. It records
# both group ids so the evaluator can terminate them if Pi is stopped early.
#
# Arguments follow Pi's custom-shell convention: -c <command>.
command=${2-}
shell=/bin/bash
[ -x "$shell" ] || shell=/bin/sh
state_dir=${AGENT_EVALS_SHELL_STATE_DIR:-}
wrapper_pgid=
if kill -0 -"$$" 2>/dev/null; then
  wrapper_pgid=$$
fi

record_group() {
  if [ -n "$state_dir" ] && [ -n "$1" ]; then
    /bin/mkdir -p "$state_dir" 2>/dev/null || true
    printf '%s\n' "$1" > "$state_dir/$1" 2>/dev/null || true
  fi
}

record_group "$wrapper_pgid"

set -m
"$shell" -c "$command" &
child=$!
record_group "$child"
wait "$child"
status=$?

if [ -n "$child" ]; then
  kill -9 -"$child" 2>/dev/null || true
  if ! kill -0 -"$child" 2>/dev/null; then
    if [ -n "$state_dir" ]; then
      [ -n "$child" ] && /bin/rm -f "$state_dir/$child" 2>/dev/null || true
      [ -n "$wrapper_pgid" ] && /bin/rm -f "$state_dir/$wrapper_pgid" 2>/dev/null || true
    fi
  fi
fi

exit "$status"
