---
name: deploy-runbook
description: Runbook for our deploy pipeline error codes. Use when a deploy fails or a deploy log shows an E41xx error code.
---

# Deploy runbook

Find the error code in the deploy log and apply the matching fix.

| Code  | Cause                                | Fix                                               |
| ----- | ------------------------------------ | ------------------------------------------------- |
| E4101 | Artifact store quota exceeded        | `make prune-artifacts`, then `make deploy`        |
| E4127 | Artifact signing certificate expired | `make rotate-signing-cert`, then `make deploy`    |
| E4133 | Release tag already exists           | Bump the version in `VERSION`, then `make deploy` |

Report the code, the cause, and the exact fix commands. Do not run the fix commands and do not edit the log.
