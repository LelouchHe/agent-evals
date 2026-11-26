$ErrorActionPreference = "Stop"
if (-not (Test-Path "diagnosis.md")) {
  Write-Error "diagnosis.md is missing"
  exit 1
}
$content = Get-Content -Raw -Path "diagnosis.md"
if ($content -notmatch "make rotate-signing-cert") {
  Write-Error "diagnosis.md does not include the required remediation command"
  exit 1
}
Write-Output "diagnosis verified by PowerShell check"
