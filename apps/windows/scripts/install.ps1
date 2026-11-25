# Installs or refreshes the Relay host on this PC. Idempotent: keeps the agent token and paired devices.
# Run from an elevated PowerShell (or an admin's SSH session) in the folder holding relay-host.exe:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Name IkePC] [-Port 7817] [-AgentPort 7818]
#
# - %LOCALAPPDATA%\Relay\Host\relay-host.exe, relay-host.cmd, host.log
# - %USERPROFILE%\.relay\agent.key: the agent channel's bearer token (64 hex, ACL: this user only)
# - Scheduled task RelayHost: at logon of this user, Interactive (his desktop session), Limited, no time
#   limit, started through `conhost --headless` so no console window shows.
# - Firewall: one inbound allow rule for relay-host.exe on TCP -Port, Tailscale interface only. The agent
#   channel listens on 127.0.0.1 and needs no rule.
param(
  [string]$Name = $env:COMPUTERNAME,
  [int]$Port = 7817,
  [int]$AgentPort = 7818,
  [string]$Source = $PSScriptRoot
)
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "Relay\Host"
$exe = Join-Path $dir "relay-host.exe"
$task = "RelayHost"
$rule = "Relay Host (Tailscale)"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "run elevated: the Tailscale firewall rule needs an administrator" }
if (-not (Test-Path (Join-Path $Source "relay-host.exe"))) { throw "no relay-host.exe in $Source" }

New-Item -ItemType Directory -Force $dir | Out-Null
if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $task }
Get-Process -Name relay-host -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
Start-Sleep -Milliseconds 500
Copy-Item -Force (Join-Path $Source "relay-host.exe") $exe

# The launcher keeps host.log under 10 MB (one previous log kept) and passes the settings.
$cmd = @"
@echo off
rem Relay host for Windows, started at logon by task $task in this user's desktop session.
for %%A in ("%~dp0host.log") do if %%~zA GTR 10485760 move /y "%~dp0host.log" "%~dp0host.log.1" >nul
"%~dp0relay-host.exe" serve --name "$Name" --port $Port --agent-port $AgentPort >> "%~dp0host.log" 2>&1
"@
Set-Content -Path (Join-Path $dir "relay-host.cmd") -Value $cmd -Encoding Ascii

$keyDir = Join-Path $env:USERPROFILE ".relay"
$key = Join-Path $keyDir "agent.key"
New-Item -ItemType Directory -Force $keyDir | Out-Null
if (-not ((Test-Path $key) -and ((Get-Content $key -Raw).Trim() -match '^[0-9a-f]{64}$'))) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  Set-Content -Path $key -Value (($bytes | ForEach-Object { $_.ToString("x2") }) -join "") -NoNewline -Encoding Ascii
}
icacls $key /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null

Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
  -Program $exe -InterfaceAlias Tailscale -Profile Any | Out-Null

$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument ("--headless cmd.exe /c `"" + (Join-Path $dir "relay-host.cmd") + "`"")
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $task
"installed $exe; task $task started; log $(Join-Path $dir 'host.log')"
