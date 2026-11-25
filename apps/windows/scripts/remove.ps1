# Removes the Relay host: the RelayHost task, the running host, its firewall rule and %LOCALAPPDATA%\Relay\Host.
# Keeps the agent token and paired devices unless -Purge (then %USERPROFILE%\.relay and ~\.config\relay go too).
# Run elevated (the firewall rule needs an administrator):
#   powershell -NoProfile -ExecutionPolicy Bypass -File remove.ps1 [-Purge]
param([switch]$Purge)
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "Relay\Host"
$task = "RelayHost"
if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $task
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
}
Get-Process -Name relay-host -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $dir "relay-host.exe") } | Stop-Process -Force
Get-NetFirewallRule -DisplayName "Relay Host (Tailscale)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Start-Sleep -Milliseconds 500
Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
if ($Purge) {
  Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE ".relay") -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE ".config\relay") -ErrorAction SilentlyContinue
}
"removed"
