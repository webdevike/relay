# Relay for Windows

The Windows host. The phone side is `apps/linux`'s own transport (`RelayServer`, `ClientSession`,
pairing, command dedup, device store, trackpad and keyboard models, VNC bridge) with Windows input
underneath, so the phone and Relay desktop pair with it unchanged. On top of that it serves an
**agent channel**: an authenticated HTTP API on 127.0.0.1 through which agents on another machine
run PowerShell, launch apps, take screenshots, list and focus windows and use the clipboard, all
inside the signed-in user's desktop session. Agents, assistants, boards and the rest of the Eva
runtime are not part of it; they stay on the Mac.

```
src/main.ts               CLI: serve (default), devices, forget <deviceId>; wires apps/linux's RelayServer
src/input.ts              SendInput records from the shared EventPoster calls (Linux KEY_* -> virtual keys, Unicode text)
src/mdns.ts               _relay._tcp through Windows' own DNS-SD (dnsapi DnsServiceRegister), TXT v=1, name, ts
src/desktop.ts            windows (EnumWindows), focus, screenshots (GDI, DIB section), clipboard text
src/png.ts                screenshot PNG encoder (node:zlib)
src/win32.ts              bun:ffi bindings (user32, gdi32, kernel32, dwmapi, dnsapi)
src/agent/server.ts       the agent channel's routes and bearer-token check
src/agent/command.machine.ts  one `run`: running -> exited | timedOut | cancelled (docs/state-machines/agent-command.md)
src/agent/command.ts      PowerShell runtime for that machine
src/agent/launch.ts       Start-Process, then wait for the new window and focus it
scripts/build.sh          cross-compile build/relay-host.exe (from macOS or Linux) and optionally install or update over SSH
scripts/install.ps1, update.ps1, remove.ps1
```

## Network exposure

- **Phone socket**: `ws://<tailnet IPv4>:7817/relay`, bound to the Tailscale address only (the host waits for
  Tailscale at logon rather than fall back to the LAN). `install.ps1` adds one inbound firewall rule,
  `Relay Host (Tailscale)`: TCP 7817, program `relay-host.exe`, interface alias `Tailscale`. Tailnet phones pair
  without a PIN, as on the other hosts. `serve --listen ADDR` binds another address (then add your own rule).
- **mDNS**: `_relay._tcp` with `ts=<tailnet IPv4>`; a phone on the same LAN discovers it and connects over the
  tailnet. Registered through Windows' DNS-SD API (Windows 10 1809+), so no Bonjour install is needed.
- **Agent channel**: `http://127.0.0.1:7818`, loopback only, no firewall rule. Every request needs
  `Authorization: Bearer <64 hex>` from `%USERPROFILE%\.relay\agent.key` (created by `install.ps1`, ACL: the
  user only). Reach it from another machine with an SSH forward (`ssh -L 17818:127.0.0.1:7818 <pc>`).

## Agent channel

```
GET  /v1/health                                  {ok, version, pid}
POST /v1/run      {command, cwd?, timeoutMs?}    PowerShell 5.1 script (may span lines); {outcome, exitCode, stdout, stderr, truncated, durationMs}
POST /v1/launch   {target, args?, cwd?, waitMs?} exe path, PATH/App Paths name, document or URI; {pid, windows, focused}
GET  /v1/windows                                 top-level windows front to back: {hwnd, title, pid, process, rect, minimized, foreground}
POST /v1/focus    {window}                       hwnd, or a title fragment matching one window
GET  /v1/shot[?window=<hwnd|title>]              image/png of the whole virtual screen or one window; X-Relay-Rect: x,y,width,height
GET  /v1/clipboard                               {text} (null when the clipboard holds no text)
PUT  /v1/clipboard {text}
```

- `run`: the script goes to a temp `.ps1` run with `-File` (UTF-8 both ways). Exit code: the script's
  `exit N`, else a native command's non-zero `$LASTEXITCODE`, else 1 when the last statement failed. Default
  timeout 60 s, at most 1 h; on timeout or when the caller hangs up the whole process tree is killed and
  `outcome` says so. 4 MB per stream, then `truncated`.
- `launch`: Start-Process, then up to `waitMs` (default 15 s) for a new window, which it raises and tries to
  focus. Windows lets a background process take the foreground only under conditions; `foreground` in the
  result is the truth. A window of a higher integrity level (an elevated app, a Windows Security prompt) keeps
  the foreground.
- `shot ?window=`: PrintWindow renders the window even when covered; a black result (some GPU-presented
  windows) falls back to the screen's pixels in its frame. Everything is physical pixels (the host is
  per-monitor DPI aware).
- Only paths and status codes are logged, never commands, clipboard text or titles.

## Run it

```sh
cd apps/windows
scripts/build.sh                                 # build/relay-host.exe + the three scripts
scripts/build.sh --install <ssh-host> -Name IkePC   # copy to the PC's %TEMP%\relay-host and run install.ps1 (admin)
scripts/build.sh --update <ssh-host>             # replace the exe and restart the task (no admin)
```

`install.ps1` puts the exe in `%LOCALAPPDATA%\Relay\Host`, writes `relay-host.cmd` (keeps `host.log` under
10 MB), creates the token if missing, adds the firewall rule and registers the scheduled task `RelayHost`: at
logon of the user, LogonType Interactive, RunLevel Limited, no time limit, started as
`conhost.exe --headless cmd.exe /c relay-host.cmd` so no console window shows. It must run in the user's
interactive session: SendInput, window and screen calls only reach the desktop of the session they run in.
`remove.ps1 [-Purge]` deletes the task, rule and install dir (`-Purge` also the token and paired devices in
`%USERPROFILE%\.config\relay`). `relay-host devices` / `forget <id>` manage paired phones.

## Gaps

- **Live view**: the VNC bridge is there (`vnc.open` answers `vnc.unavailable` until a VNC server listens on
  127.0.0.1:5900), but no VNC server is bundled or installed. A loopback-only one (TightVNC with
  `LoopbackOnly`, UltraVNC) makes it work through the authenticated bridge.
- Input stops while the screen is locked or a UAC prompt is up, and cannot reach elevated windows (UIPI).
- Pasting a phone image goes through PowerShell's `System.Windows.Forms.Clipboard` (about a second).
- No agent inbox, assistants, boards, drops or meetings: those run on the Mac host.
