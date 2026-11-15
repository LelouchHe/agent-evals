#!/bin/sh
self=$0
bindir=__BINDIR__
socket=__SOCKET__
fault=__FAULT__
encode() {
  printf '%s' "$1" | /usr/bin/base64 | /usr/bin/tr -d '\n'
  printf '\n'
}
# Canonicalise our own path so the host can tell which forwarder directory we came from.
folder=${self%/*}
[ "$folder" = "$self" ] && folder=.
self=$(cd "$folder" && pwd -P)/${self##*/}
reply=$(
  {
    encode "$self"
    for argument in "$@"; do
      encode "$argument"
    done
  } | /usr/bin/nc -U "$socket"
) || {
  printf '%s: Service unavailable\n' "${self##*/}" >&2
  printf '%s\n' "${self##*/}" >>"$fault" 2>/dev/null
  exit 126
}
IFS=' ' read -r kind code out err <<EOF
$reply
EOF
if [ "$kind" = pass ]; then
  name=${self##*/}
  case $self in
    "$bindir"/*)
      oldifs=$IFS
      IFS=:
      set -f
      for folder in $PATH; do
        candidate=$folder/$name
        [ -f "$candidate" ] || continue
        [ -x "$candidate" ] || continue
        # Skip our own entry even when PATH spells the directory differently.
        if [ "$(cd "$folder" 2>/dev/null && pwd -P)/$name" = "$self" ]; then continue; fi
        set +f
        IFS=$oldifs
        exec "$candidate" "$@"
      done
      set +f
      IFS=$oldifs
      ;;
    *)
      real=${self%/*}/.${name}
      if [ -x "$real" ]; then exec "$real" "$@"; fi
      ;;
  esac
  printf '%s: Operation not permitted\n' "$name" >&2
  exit 126
fi
[ "$out" = - ] && out=""
[ "$err" = - ] && err=""
if [ -n "$out" ]; then printf '%s' "$out" | /usr/bin/base64 -D; fi
if [ -n "$err" ]; then printf '%s' "$err" | /usr/bin/base64 -D >&2; fi
exit "$code"
