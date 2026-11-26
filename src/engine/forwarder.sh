#!/bin/sh
exec 3>&1
target=$(__NODE__ __CLIENT__ __BINDIR__ __SOCKET__ __FAULT__ "$0" "$@" 4>&1 1>&3)
status=$?
exec 3>&-
if [ "$status" -eq 0 ] && [ -n "$target" ]; then
  exec "$target" "$@"
fi
exit "$status"
