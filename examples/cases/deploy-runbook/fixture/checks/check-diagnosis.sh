#!/bin/sh
# Public invariants only: this file ships in the fixture, so it must not reveal the
# skill's private cause or fix. It proves diagnosis.md exists and repeats the error
# code deploy.log already shows.
set -eu
test -s diagnosis.md
grep -Fq 'E4127' diagnosis.md
grep -Fq 'E4127' deploy.log
