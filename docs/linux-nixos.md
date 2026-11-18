# Relay on Linux (NixOS)

Relay on Linux is the same app Isaac runs on his Macs: the desktop app (chats with your assistants,
canvas boards, Files, Studio) and the host your iPhone pairs with. One command builds and starts all
of it from this repo.

## What you need

- Linux with Nix and flakes (NixOS 26.05 tested on aarch64; x86_64 builds from the same flake), and
  a graphical session (X11 or Wayland).
- Read access to `github.com/webdevike/relay` (Isaac adds you) and git credentials for it.
- An AI account for the assistants: an Anthropic or OpenAI API key, a Claude subscription (Pro or
  Max) or a ChatGPT subscription (Plus or Pro). Relay's setup signs you in.
- For the phone: an iPhone, and Tailscale on both devices (or the same Wi-Fi, see below).

Nothing else: the flake brings omp (the agent engine), herdr, Bun and Electron.

## Run it

```sh
git clone git@github.com:webdevike/relay.git
cd relay
nix run .#relay
```

The first build takes a while (it compiles the desktop app); later runs start at once. Relay opens
its setup, ten short steps:

1. **Welcome**, then **Check your computer**: Bun, omp and herdr come from the flake, so nothing
   needs installing.
2. **Connect AI**: sign in with Claude or ChatGPT in the browser, or **Use an API key** (Anthropic or
   OpenAI). omp keeps the key; Relay keeps no copy.
3. **Your home base**: one folder (`~/Relay` by default) your assistants read and write, your name
   and optionally a first project.
4. **Your assistants**: one general assistant, or a personal and a work one.
5. **Long-term memory** (optional): runs in Docker on Linux. Skip it, or enable Docker first
   (`virtualisation.docker.enable = true;` and your user in the `docker` group).
6. **Relay Host**: name this computer (your iPhone shows the name) and install. Relay writes
   `~/.config/relay/host.json` and starts the host on port 7817 and herdr.
7. **Your iPhone**: see below, or skip and come back from Settings, Setup.
8. **Open Relay**: the app restarts into its main window (the terminal you started it from gets its
   prompt back; Relay keeps running).

Open **Assistants**, pick your assistant, press **Start Assistant** and send it a message.
**Canvas** has your boards (saved in `~/.config/Relay/canvases`).

Next time: `cd relay && git pull && nix run .#relay`.

## Keep it running (NixOS module)

`nix run .#relay` starts the host when the app starts, so your phone reaches it while Relay is
open. To keep it up all the time, put `relay` on your PATH and in your app launcher, and give the
phone keyboard and trackpad, add the module:

```nix
# flake.nix
inputs.relay.url = "git+ssh://git@github.com/webdevike/relay";

# configuration.nix (relay in the module arguments)
imports = [ relay.nixosModules.default ];
services.relay = {
  enable = true;
  users = [ "you" ];   # runs the units and joins uinput: log out and in once after switching
};
```

After `nixos-rebuild switch` two user units run for the listed users: `relay-host` and `herdr`
(`systemctl --user status relay-host`). The module opens TCP 7817 and turns
on avahi publishing (mDNS) and uinput. `loginctl enable-linger $USER` keeps them up while you are
logged out.

## Pair your iPhone

1. Install Relay from TestFlight: https://testflight.apple.com/join/hjsTe54Y (setup's iPhone step
   shows it as a QR code; ask Isaac if the link is full or expired).
2. **With Tailscale** (what setup walks you through, and works away from home): on NixOS
   `services.tailscale.enable = true;`, then `sudo tailscale up`. Sign in to the same tailnet on the
   iPhone, press Check again in setup, and in the Relay app go to Settings, Computers, Add by
   address with the address setup shows. Phones on your tailnet pair without a PIN.
3. **Same Wi-Fi, no Tailscale**: the phone finds the computer over mDNS (the module turns that on;
   without it add `services.avahi = { enable = true; publish = { enable = true; userServices = true; }; };`
   and `networking.firewall.allowedTCPPorts = [ 7817 ];`). Tap the computer, then enter the 6-digit
   PIN. The desktop app does not show it yet: read it with `cat ~/.config/relay/pairing.json` (it
   exists for the 2 minutes the pairing is open) or in the host log (`~/.local/state/relay/host.log`,
   with the module `journalctl --user -u relay-host -f`).

Phone app updates come with new TestFlight builds. Isaac's over-the-air updates are served on his
own tailnet, so a phone outside it keeps the code its TestFlight build shipped with.

## What does not work on Linux

| Feature                                                    | Why                                                                                                   |
| :--------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| Meeting capture (call audio and transcription)             | macOS audio process tap and Apple-silicon MLX                                                         |
| Relay Assist and computer use                              | macOS Accessibility and screen recording                                                              |
| Studio's local video and image models (LTX, MOSS, Kontext) | MLX, Apple silicon only; ComfyUI (`RELAY_STUDIO_COMFYUI_URL`), OpenRouter and Codex backends work     |
| Long-term memory without Docker                            | the native engine is macOS only; the Docker engine works                                              |
| PIN for Wi-Fi pairing in the app                           | the host writes it to `~/.config/relay/pairing.json`; no desktop display yet (Tailscale needs no PIN) |
| Browser login import, open at login, in-app updates        | macOS only; use the module and `git pull`                                                             |
| Phone keyboard text on GNOME                               | GNOME has no virtual-keyboard protocol for `wtype`; ASCII still types through uinput                  |
| Phone live view of the desktop                             | needs a local VNC server on 127.0.0.1:5900 (`wayvnc`, `krfb` or `x11vnc`)                             |

Keyboard shortcuts use Ctrl where the Mac uses Cmd.

## Troubleshooting

- Logs: `~/.local/state/relay/host.log`, `herdr.log` and `setup.log`; with the module
  `systemctl --user status relay-host herdr`.
- Run setup again: Settings, Setup.
- Start over: quit Relay, then remove `~/.config/Relay Desktop`, `~/.config/Relay`,
  `~/.config/relay`, `~/.local/state/relay` and `~/Relay` (your omp sign-in in `~/.omp` stays).
