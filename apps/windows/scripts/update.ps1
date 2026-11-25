# Replaces relay-host.exe with the one beside this script and restarts the RelayHost task. Keeps the
# launcher settings, token, firewall rule and paired devices; needs no elevation. Run install.ps1 instead
# to change the name or ports.
#   powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1
param([string]$Source = $PSScriptRoot)
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "Relay\Host"
$exe = Join-Path $dir "relay-host.exe"
$task = "RelayHost"
if (-not (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) { throw "task $task is missing: run install.ps1" }
if (-not (Test-Path (Join-Path $Source "relay-host.exe"))) { throw "no relay-host.exe in $Source" }
Stop-ScheduledTask -TaskName $task
Get-Process -Name relay-host -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
Start-Sleep -Milliseconds 500
Copy-Item -Force (Join-Path $Source "relay-host.exe") $exe
Start-ScheduledTask -TaskName $task
"updated $exe; task $task restarted"
