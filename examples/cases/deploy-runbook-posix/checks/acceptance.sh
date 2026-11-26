#!/bin/sh
# Private acceptance details, supplied only at check time through `shell.files`.
# This file stays outside fixture/, so the agent never sees it during the run.
set -eu
test -s diagnosis.md
grep -Fq 'E4127' diagnosis.md
grep -Fq 'make rotate-signing-cert' diagnosis.md
grep -Fq 'make deploy' diagnosis.md
grep -Fq '41A7' diagnosis.md
grep -Fq '2.8.1-b41' diagnosis.md
grep -Eq 'Darwin|Linux' diagnosis.md
