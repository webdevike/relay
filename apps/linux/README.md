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

### macOS

The bundled `Relay Host.app` uses `relay-input.dylib` (CoreGraphics) for phone
trackpad movement, clicks, dragging, pixel scrolling and Unicode keyboard input.
It does not attempt to open `/dev/uinput` on macOS. Build with
`sh apps/mac-host/build.sh <version>`; the native input library ships beside the
compiled daemon. For source runs, set `RELAY_INPUT_LIBRARY` to that built library.

Grant **Relay Host** access in System Settings → Privacy & Security →
Device Control and Data Access (Accessibility). Until granted, input is refused
while pairing and chat continue to work. Trust is checked live, but macOS can cache
the result in the daemon. Restart Relay Host after granting access, then reconnect
the phone to refresh its status.
The native backend uses all active display bounds, including extended AirPlay displays.
Existing Linux Ctrl shortcuts map to macOS Command, and text uses UTF-16 events.

Bonjour goes through the system mDNSResponder (`dns-sd -R`), the agent socket is
`/tmp/relay-agents.sock`, and the clipboard watcher remains off without `wl-paste`.

### NixOS

The flake at the repo root packages the daemon (`bun` plus avahi, wtype and wl-clipboard on its
PATH) and a module that sets up everything above:

```nix
# flake.nix inputs
relay.url = "github:webdevike/relay";

# configuration.nix (with relay in the module's args)
imports = [ relay.nixosModules.default ];
services.relay-linux = {
  enable = true;
  users = [ "you" ];   # joins the uinput group; log out and in once after the switch
};
```

That enables `hardware.uinput`, avahi with user-service publishing, opens TCP 7817, and installs a
systemd user unit `relay-linux` bound to `graphical-session.target`; the PIN shows in
`journalctl --user -u relay-linux -f`. Without the module: `nix run github:webdevike/relay -- serve
--port 7817` (uinput, avahi and the firewall are then yours to configure). For the Agent Inbox,
symlink `/run/current-system/sw/share/relay-linux/omp-extension/relay-bridge.ts` into
`~/.omp/agent/extensions/`.

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
`agent.reply` with `submit: true` is delivered like typing in the TUI and pressing Enter (a text
that starts with `/` is fed through the editor so omp dispatches it as a command); with
`submit: false` it is placed in the session's editor for the keyboard to finish. Images pasted on
the phone ride along on the reply as image parts of that user turn (so they always submit, and a
`/command` sent with images goes to the model as text rather than being dispatched); images in the
transcript, whether pasted or returned by a tool, are listed on the message as references and
fetched by id with `agent.image` (the extension keeps the newest 32). `agent.options`
answers with the models the session can switch to and the entries for the phone's skill wheel:
authored skills (`/skill:<name>`), prompt and extension commands, and the built-in commands that
take text (`/handoff`, `/rename`, ...); a built-in with subcommands offers the ones that take text
(`/goal set`, `/compact <mode>`), each entry carrying the exact token to prefix. `agent.start`
(the plus on the phone's scrubber) creates a Herdr workspace and starts omp there. It passes the
phone's optional `personal` or `work` profile after Herdr's argument separator, so omp reads that
profile's isolated authentication and state. `<dir>` is `serve --agent-home DIR` (default `$HOME`).
`agent.end` (End session in the phone's session sheet) submits `/exit` in the TUI once the ack has
gone out, so omp tears down exactly as it would from the keyboard and its terminal closes.

### Tool approvals

A session in an approval mode (`--approval-mode always-ask`, or `write` for a write or exec tool) blocks
on omp's prompt `ctx.ui.select("Allow tool: <name>\n<details>", ["Approve", "Deny"])`. The extension wraps
that select: the prompt still opens in the terminal, and the host also gets `approval.request` (tool call
id, tool name, the detail lines verbatim, omp's reason) and sends subscribed devices `agent.approval`.
`agent.approve` / `agent.deny` (`sessionId`, `approvalId` = the tool call id) answer it; whichever answers
first wins, a device's answer closes the terminal selector through its abort signal and omp carries on as if
it had been picked there, and every device gets `agent.approval.resolved`. A late answer nacks
`agent_cannot_respond`. The host replays a pending approval to a device that subscribes after it was raised,
and the extension raises it again if the host restarted meanwhile.

A call that matches the destructive list (`src/agents/destructive.ts`: force push, `rm -rf`, deploy, writes
under `prod`/`production` paths; the same list as EvaOS's inbox) is sent with `requiresBiometric: true` and
a `destructive` name. Approving one needs `confirmed: "biometric"` (Face ID on the phone) or
`confirmed: "desktop"` (EvaOS, at the Mac); without it the ack is `biometric_required`. Denying never needs
it. There is no "always allow" for these, and the protocol has none for any approval.

## Differences from the Mac app

- No tray/menu UI; the terminal is the UI.
- Agent provider is omp only (via the extension above), not Claude Code.
- No TLS (same as Mac v1).
