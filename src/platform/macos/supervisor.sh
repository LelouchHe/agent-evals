# Deliberately not a standalone executable: only passed to /bin/sh -c inside
# sandbox-exec with our generated same-sandbox signal policy. FD 3 is the
# private completion channel; the workload never inherits it. Save stdin on
# FD 4 because asynchronous shell commands otherwise receive /dev/null.
trap 'kill -KILL -- -1' TERM INT HUP
exec 4<&0
"$@" <&4 3>&- 4<&- &
child=$!
exec 4<&-
wait "$child"
status=$?
printf '%s\n' "$status" >&3
kill -KILL -- -1
