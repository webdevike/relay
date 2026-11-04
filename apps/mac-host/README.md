# Relay Host (Mac wrapper)

`RelayHost.swift` is a menu-bar app that runs the bundled `relay-host` daemon (`apps/linux`), registers as a login item and updates itself from GitHub releases. `RelayInput.c` is the Accessibility input dylib.

## Settings

The wrapper reads `~/.config/relay/host.json` (the setup wizard writes it) and falls back to the original logic without it:

```json
{ "agentHome": "/Users/jane/Relay", "name": "Jane's Mac Studio", "port": 7817 }
```

- `agentHome`: default `~/Eva` when it exists, else `$HOME`.
- `name`: default the Mac's name. `port`: default 7817.
- `relay-host` itself reads the same file for anything the wrapper does not pass (`human`, `features`), see `apps/linux/src/host-config.ts`.

The wrapper starts `relay-host` with `PATH` extended by `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, so `omp`, `herdr` and `bun` resolve under a login item.

## Build

```sh
cd apps/mac-host
./build.sh 0.2.0            # build/Relay Host.app and build/RelayHost.zip
./build.sh 0.2.0 --release  # also publishes GitHub release host-v0.2.0 (Isaac's update channel)
./build.sh 0.2.0 --dist     # self-contained app for other machines: dist/Relay Host.app
```

`--dist` bundles the `relay-host` binary (compiled with Bun), the input dylib, `Contents/Resources/omp-extension/` (`relay-bridge.ts`, plus herdr's `herdr-omp-agent-state.ts` when the build machine has it) and `Contents/Resources/asr/relay_asr.py` (the meetings transcription worker; every build has it, its venv comes from `apps/linux/asr/setup.sh`), signs everything with the first local `Apple Development` identity (ad hoc when none), and copies the app to `dist/Relay Host.app`. No GitHub release. Bundle ids are unchanged (`com.ike.relay.host`, `.daemon`, `.input`). Requires `bun`, `swiftc` and `clang`.

On first start `relay-host` copies the bundled omp extensions into `~/.omp/agent/extensions/` when they are missing (never overwriting) and starts herdr's server through the user LaunchAgent `dev.relay.herdr` when none is running.

## Pairing

A phone on the tailnet (100.64.0.0/10 or fd7a:115c:a1e0::/48) pairs with no PIN. Any other phone gets a 6-digit PIN that is printed to `~/Library/Logs/RelayHost.log` and written, while the pairing is open, to `~/.config/relay/pairing.json` as `{"pin","expiresAt"(epoch ms),"deviceName"}` (0600), removed when pairing ends. The iPhone app's "Add by address" takes `host:port` (for example `100.101.102.103:7817`).
