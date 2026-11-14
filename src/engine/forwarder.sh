#!/bin/sh
self=$0
socket=__SOCKET__
encode() {
  printf '%s' "$1" | /usr/bin/base64 | /usr/bin/tr -d '\n'
  printf '\n'
}
{
  encode "$self"
  for argument in "$@"; do
    encode "$argument"
  done
} | /usr/bin/nc -U "$socket" | {
  IFS= read -r code || {
    printf '%s: Service unavailable\n' "${self##*/}" >&2
    exit 126
  }
  IFS= read -r out
  IFS= read -r err
  if [ -n "$out" ]; then printf '%s' "$out" | /usr/bin/base64 -D; fi
  if [ -n "$err" ]; then printf '%s' "$err" | /usr/bin/base64 -D >&2; fi
  exit "$code"
}
exit $?
