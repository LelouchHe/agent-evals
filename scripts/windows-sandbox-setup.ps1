#Requires -RunAsAdministrator
<#
.SYNOPSIS
  One-time setup (or teardown) for @lelouchhe/agent-evals native Windows sandbox users.
.DESCRIPTION
  Creates two unprivileged local accounts:
    - agent-evals-online  : network-enabled sandbox user for evaluated agents
    - agent-evals-offline : network-blocked sandbox user (Windows Firewall outbound block by SID)
  Stores freshly generated random passwords in an owner-only JSON file so win-sandbox.exe
  can log on via LogonUserW without any real user credentials.
#>
param(
  [string]$CredentialsPath = (Join-Path $env:LOCALAPPDATA "agent-evals\sandbox-users.json"),
  [switch]$Teardown
)

$ErrorActionPreference = "Stop"

$OnlineUser = "agent-evals-online"
$OfflineUser = "agent-evals-offline"
$FirewallRuleName = "agent-evals-offline outbound block"

if ($Teardown) {
  Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  foreach ($name in @($OnlineUser, $OfflineUser)) {
    if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) {
      Remove-LocalUser -Name $name
    }
  }
  if (Test-Path $CredentialsPath) {
    Remove-Item -Force $CredentialsPath
  }
  Write-Host "Removed $OnlineUser, $OfflineUser, firewall rule, and credentials file."
  exit 0
}

function New-RandomPassword {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  # Ensure Windows complexity requirements (upper, lower, digit, symbol).
  return "Ae!9" + [Convert]::ToBase64String($bytes)
}

function Ensure-SandboxUser([string]$Name, [string]$Description) {
  $plain = New-RandomPassword
  $secure = ConvertTo-SecureString $plain -AsPlainText -Force
  $existing = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Set-LocalUser -Name $Name -Password $secure -PasswordNeverExpires $true -UserMayNotChangePassword $true
  } else {
    New-LocalUser -Name $Name -Password $secure -Description $Description -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
  }
  # Add to standard Users group (read/execute on system binaries, NO access to other users' %USERPROFILE%).
  $isMember = (Get-LocalGroupMember -Group "Users" -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*\$Name" })
  if (-not $isMember) {
    Add-LocalGroupMember -Group "Users" -Member $Name
  }
  $sid = (Get-LocalUser -Name $Name).SID.Value
  return @{
    username = $Name
    password = $plain
    sid = $sid
  }
}

$online = Ensure-SandboxUser -Name $OnlineUser -Description "Unprivileged online sandbox account for @lelouchhe/agent-evals"
$offline = Ensure-SandboxUser -Name $OfflineUser -Description "Unprivileged offline sandbox account for @lelouchhe/agent-evals"

# Ensure Windows Defender Firewall is enabled so the offline user outbound block is enforced.
Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True

# Recreate outbound block rule scoped strictly to agent-evals-offline's SID.
Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$localUserSddl = "D:(A;;CC;;;$($offline.sid))"
New-NetFirewallRule `
  -DisplayName $FirewallRuleName `
  -Direction Outbound `
  -Action Block `
  -LocalUser $localUserSddl `
  -Profile Any `
  -Enabled True | Out-Null

$credDir = Split-Path -Parent $CredentialsPath
New-Item -ItemType Directory -Force -Path $credDir | Out-Null

$payload = @{
  online = @{
    username = $online.username
    password = $online.password
    sid = $online.sid
  }
  offline = @{
    username = $offline.username
    password = $offline.password
    sid = $offline.sid
  }
} | ConvertTo-Json -Depth 4

Set-Content -Path $CredentialsPath -Value $payload -Encoding UTF8

# Restrict credentials file to current user + SYSTEM + Administrators (strip Users/Everyone).
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $CredentialsPath /inheritance:r /grant:r "${currentUser}:(F)" "SYSTEM:(F)" "Administrators:(F)" | Out-Null

Write-Host "Configured $OnlineUser ($($online.sid)) and $OfflineUser ($($offline.sid))"
Write-Host "Credentials saved to $CredentialsPath"
