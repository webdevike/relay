# Relay for Linux

The Linux host: the same wire protocol as `apps/mac`, so the phone app pairs and connects
without changes. Runs as a terminal daemon on Bun.

```
src/main.ts          CLI: serve (default), devices, forget <deviceId>
src/server.ts        Bun.serve WebSocket listener, one ClientSession per connection
src/session.ts       Port of ClientSession.swift (hello -> challenge/auth | pairing -> welcome)
src/dedup.ts         Port of CommandDedupStore.swift (cmd replay across reconnects)
src/pairing.ts       Port of PairingCoordinator.swift + terminal PIN display
src/device-store.ts  Paired secrets in $XDG_CONFIG_HOME/relay/devices.json (0600)
src/mdns.ts          `_relay._tcp` via avahi-publish (TXT v=1, name=<host>)
src/input/uinput.ts  Virtual mouse+keyboard on /dev/uinput (bun:ffi for ioctl only)
src/input/trackpad.ts, pointer-model.ts   Port of TrackpadInputSink / PointerModel
src/input/keyboard.ts  Named keys via uinput; text via wtype (Wayland) or a US-layout fallback
```

## Requirements

- bun >= 1.2, `avahi-daemon` running with `avahi-publish` installed.
- Read/write on `/dev/uinput`: add yourself to the `input` group (`sudo usermod -aG input $USER`,
  then log out and in), or a udev rule such as `KERNEL=="uinput", MODE="0660", GROUP="input"`.
- Wayland: `wtype` for Unicode text. Without it (or on X11) text falls back to uinput with a US
  layout and non-ASCII characters are refused with `invalid_command`.

## Run

```
cd apps/linux
bun run src/main.ts serve            # ephemeral port; --port N --name NAME to override
bun run src/main.ts devices
bun run src/main.ts forget <deviceId>
```

The phone finds the host through Bonjour, sends `pair.request`, the PIN prints in this terminal,
and after `pair.ok` every reconnect authenticates with HMAC over the stored secret. Pointer motion
is emitted as relative `REL_X/REL_Y`; the compositor's own libinput acceleration applies on top of
`PointerModel`'s. Scroll is `REL_WHEEL_HI_RES` (120 units per 24 phone pixels) plus a legacy
`REL_WHEEL` click per whole notch.

When `/dev/uinput` cannot be opened the daemon still runs: the phone sees
`accessibilityGranted: false`, input is dropped and commands are nacked `accessibility_denied`.

## Agent Inbox (omp)

Symlink `omp-extension/relay-bridge.ts` into `~/.omp/agent/extensions/`. Every interactive omp
session then registers with the daemon over `$XDG_RUNTIME_DIR/relay-agents.sock` and appears in
the phone's Agent Inbox with its transcript and status (`working`, `waiting` after a turn that ends
in a question, `needs_permission` during a tool approval prompt, `idle`, `ended`). An
`agent.reply` with `submit: true` is delivered like typing in the TUI and pressing Enter; with
`submit: false` it is placed in the session's editor for the keyboard to finish.

## Differences from the Mac app

- No tray/menu UI; the terminal is the UI.
- Agent provider is omp only (via the extension above), not Claude Code.
- No TLS (same as Mac v1).
