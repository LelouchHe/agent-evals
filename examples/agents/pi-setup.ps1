<#
.SYNOPSIS
  Prepare deps/ for examples/agents/pi.yml on Windows.
.DESCRIPTION
  Installs @earendil-works/pi-coding-agent and pi-acp into <TargetDir>\deps and places
  cmd shims in <TargetDir>\deps\bin alongside node.exe so the sandboxed ACP runner can
  launch `pi-acp` without accessing the operator's global PATH.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$TargetDir
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
$Root = (Resolve-Path $TargetDir).Path
$Deps = Join-Path $Root "deps"
$BinDir = Join-Path $Deps "bin"
$PkgsDir = Join-Path $Deps "share\pkgs"
New-Item -ItemType Directory -Force -Path $BinDir, $PkgsDir | Out-Null

$NodeExe = (Get-Command node).Source
$NpmCmd = (Get-Command npm).Source

$PkgJson = Join-Path $PkgsDir "package.json"
if (-not (Test-Path $PkgJson)) {
  Set-Content -Path $PkgJson -Value '{"private":true}' -Encoding UTF8
}

$PiAcpSpec = if ($env:PI_ACP_SPEC) { $env:PI_ACP_SPEC } else { "pi-acp" }
& $NpmCmd install --prefix $PkgsDir --no-audit --no-fund "@earendil-works/pi-coding-agent" $PiAcpSpec
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Copy node.exe into deps\bin and create .cmd shims pointing into deps\share\pkgs\node_modules\.bin.
Copy-Item -Force $NodeExe (Join-Path $BinDir "node.exe")
foreach ($tool in @("pi", "pi-acp")) {
  $shimPath = Join-Path $BinDir "$tool.cmd"
  $shim = "@echo off`r`n`"%~dp0..\share\pkgs\node_modules\.bin\$tool.cmd`" %*`r`n"
  Set-Content -Path $shimPath -Value $shim -Encoding ASCII
}

Write-Host "Prepared Pi harness directories:"
Write-Host "  PI_DEPS=$Deps"
