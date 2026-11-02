# Relay setup scripts

Shell scripts the first-run wizard runs to get a new Mac ready. They ship inside the app (`electron-builder.yml` `extraResources`: `resources/setup` to `Relay.app/Contents/Resources/setup`; in dev run them from this folder). macOS only, bash 3.2 compatible (the system bash), no `jq` (JSON is read with `plutil`), no silent `sudo`.

Common rules

- Idempotent: running twice is safe; an installed thing is left alone.
- `detect.sh` prints one JSON object. The others speak a line protocol on stdout: `PROGRESS <0-100> <message>` (zero or more), then `OK <message>` (exit 0) or `ERR <message>` (exit 1). `ERR` is always one line.
- Installer chatter goes to `~/Library/Logs/Relay/setup.log`, never stdout. Override the folder with `RELAY_SETUP_LOG_DIR`.
- Steps that need admin rights use the macOS password prompt (`osascript ... with administrator privileges`). The scripts never see a password.
- `lib.sh` holds the shared helpers (protocol, tool discovery, JSON reading); it is sourced, not run. It puts `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin` and `/usr/local/bin` on PATH because a GUI app starts with a minimal PATH.

## detect.sh

Read-only; installs, starts and writes nothing.

```
{"brew":{"installed":true,"version":"7.0.12","path":"/opt/homebrew/bin/brew"},
 "bun":{...},
 "omp":{"installed":true,"version":"18.8.5","path":"...","loggedIn":true,"providers":["anthropic","openai-codex"]},
 "herdr":{...},
 "tailscale":{"installed":true,"version":"1.104.4","path":"...","running":true,"loggedIn":true,"tailnetIp":"100.x.y.z"},
 "relayHost":{"installed":true,"running":true,"version":"0.2.47","port":7817}}
```

Missing tools have `installed:false` and `null` version/path. How each field is found:

- `omp.providers`: `omp usage accounts --json` (local, fast; `mcp_oauth:*` entries are skipped) plus `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` lines in `~/.omp/agent/.env` (reported as `anthropic` / `openai`). `loggedIn` is true when the list is not empty.
- `tailscale`: installed from the CLI on PATH or `/Applications/Tailscale.app` (version from `Info.plist`). The CLI is only run (`status --json`, `BackendState` and `Self.TailscaleIPs[0]`) when the Tailscale app process is already running (`pgrep`); otherwise it reports `running:false, loggedIn:false`. detect never launches the app, since any CLI call would pop macOS VPN dialogs.
- `relayHost.installed`: `~/Applications/Relay Host.app` or `/Applications/Relay Host.app`; `running`: `~/.config/relay/serve.json` (`{port,pid}`) with a live pid.

```
./detect.sh
```

## install.sh `<tool>`

`brew | bun | omp | herdr | tailscale | relay-host`. Final line `OK <version>` or `OK <version> (already installed)`.

| Tool       | Method (official)                                                                                                                                                                                                                                    | Source                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| brew       | `Homebrew.pkg` from the latest GitHub release, signature-checked, installed with `installer` under the admin prompt. Brew is optional for Relay itself; the other tools do not use it.                                                               | github.com/Homebrew/brew/releases                        |
| bun        | `curl -fsSL https://bun.sh/install \| bash` (installs to `~/.bun`, edits the shell rc)                                                                                                                                                               | bun.sh/docs/installation                                 |
| omp        | `curl -fsSL https://omp.sh/install \| sh -s -- --binary`: prebuilt binary to `~/.local/bin/omp`, sha256-verified, no Bun needed. Then `herdr integration install omp` if herdr is present.                                                           | omp.sh, github.com/can1357/oh-my-pi `scripts/install.sh` |
| herdr      | `curl -fsSL https://herdr.dev/install.sh \| sh`: checksum-verified binary to `~/.local/bin/herdr`. Then `herdr integration install omp` if omp is present. This is the terminal tool (`herdr server`, `herdr workspace ...`) that Relay Host drives. | herdr.dev/tui                                            |
| tailscale  | Standalone `Tailscale-latest-macos.pkg` from `pkgs.tailscale.com/stable`, signature-checked, installed under the admin prompt. The app is NOT launched (its first start pops macOS VPN dialogs); the wizard opens it when the user asks.                                                                                       | pkgs.tailscale.com                                       |
| relay-host | Delegates to `install-host.sh <root> <hostName>` (defaults: `$RELAY_HOME_ROOT` or `~/Relay`, the Mac's computer name).                                                                                                                               | below                                                    |

Manual test (do NOT run on a machine that already has your setup): `./install.sh bun`, `./install.sh omp`, ... On an installed machine each prints `OK <version> (already installed)` and changes nothing.

## ai-login.sh

```
./ai-login.sh anthropic            # omp login anthropic: browser sign-in with a Claude account
./ai-login.sh openai               # omp login openai-codex: browser sign-in with a ChatGPT account
printf '%s' "$KEY" | ./ai-login.sh --api-key anthropic   # writes ANTHROPIC_API_KEY=... to ~/.omp/agent/.env (chmod 600)
printf '%s' "$KEY" | ./ai-login.sh --api-key openai      # OPENAI_API_KEY=...
```

Prints `OK <provider>` when done; an existing sign-in prints `OK <provider> (already signed in)`. The key is never echoed or logged. omp loads `~/.omp/agent/.env` itself (omp.sh/docs/providers).

## scaffold-home.sh `<root>` `<answers.json>`

Builds the ICM home base from `starter-home/`. Never overwrites an existing file. Prints `OK <root> (<n> created, <m> kept)`.

```
{"userName":"Jane","assistants":[{"id":"nova","name":"Nova","purpose":"Personal assistant","model":"anthropic/claude-opus-5-5"}],"firstWorkspace":{"name":"Acme","description":"My client"}}
```

- `id` is optional (derived from the name); it must match `^[a-z][a-z0-9-]*$`. `model` and `firstWorkspace` are optional.
- Writes `.omp/assistant/agents.json` in the schema Relay Host reads (`{agents:[{id,title,scope?,model?,avatar:{style:"micah",seed,colors}}]}`; no `profile`, so omp's default account is used), `.omp/assistant/agents/<id>/prime.md`, and `work/agents/<id>/thread.md` per assistant.
- Template names starting with `dot-` become dotfiles (`dot-omp` is `.omp`) so packagers keep them; `__ID__` folders are per-assistant templates. Placeholders: `{{userName}} {{assistantName}} {{assistantId}} {{assistantPurpose}} {{assistantList}} {{assistantNames}} {{workspaceIndex}} {{today}} {{homeRoot}}`.
- The optional `bun .omp/tools/icm-lint.ts` checks the shape; it needs `git init` in the home base.

```
./scaffold-home.sh /tmp/relay-starter-test answers.json && rm -rf /tmp/relay-starter-test
```

## install-host.sh `<root>` `<hostName>`

Installs Relay Host for this user and starts it.

1. Refuses (`ERR`) when `ai.eva.relay-host` (an existing LaunchAgent setup) is present, when `<root>` does not exist, or when the port (7817, or `RELAY_HOST_PORT`) is taken.
2. Copies the app to `~/Applications/Relay Host.app`: from `$RELAY_HOST_APP` (dev), else `<Relay.app>/Contents/Resources/RelayHost/Relay Host.app` (packaged). The packaging step that bundles that folder is outside these scripts.
3. Writes `~/.config/relay/host.json` `{"agentHome","name","port"}`.
4. If the bundle ships `Contents/Resources/omp-extension/relay-bridge.ts` it is copied to `~/.omp/agent/extensions/` when missing.
5. When herdr is installed and nothing keeps a herdr server alive (no `ai.eva.herdr`, no answer from `herdr workspace list`), installs LaunchAgent `dev.relay.herdr` (`herdr server`).
6. Installs LaunchAgent `dev.relay.host` (`relay-host serve --port --name --agent-home --no-clipboard --boards`; PATH `~/.local/bin:~/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`; log `~/Library/Logs/RelayHost.log`), starts it with `launchctl bootstrap`, and waits up to 60 s for `~/.config/relay/serve.json` with a live pid. Ends `OK <host version>`.

The LaunchAgent runs the `relay-host` binary directly; the SwiftUI wrapper (`RelayHost` login item) is not opened, so two hosts never fight over the port.

Manual test only on a clean Mac or VM: `RELAY_HOST_APP="/path/to/Relay Host.app" ./install-host.sh ~/Relay "Test Mac"`. Undo: `launchctl bootout gui/$(id -u)/dev.relay.host`, delete `~/Library/LaunchAgents/dev.relay.*.plist`, `~/Applications/Relay Host.app`, `~/.config/relay/host.json`.
