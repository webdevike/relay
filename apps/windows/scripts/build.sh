#!/bin/sh
# Cross-compiles the Windows host on macOS or Linux into build/relay-host.exe (Bun, x64), next to
# copies of the install/update/remove scripts, so build/ is everything a PC needs.
#   scripts/build.sh --install <ssh-host> [-Name IkePC ...]  also copy build/ to the PC's %TEMP%\relay-host
#                                          and run install.ps1 with the given parameters
#   scripts/build.sh --update <ssh-host>   ... and run update.ps1 (exe only, no elevation)
# The PC's SSH server must land in cmd.exe (Windows OpenSSH's default) with an admin account for --install.
set -eu
cd "$(dirname "$0")/.."
rm -rf build && mkdir -p build
bun build --compile --target=bun-windows-x64 src/main.ts --outfile build/relay-host.exe
cp scripts/install.ps1 scripts/update.ps1 scripts/remove.ps1 build/
case "${1:-}" in
  --install | --update)
    HOST=${2:?ssh host}
    SCRIPT=$( [ "$1" = --install ] && echo install.ps1 || echo update.ps1 )
    shift 2
    ssh "$HOST" 'if not exist "%TEMP%\relay-host" mkdir "%TEMP%\relay-host"'
    scp -q build/relay-host.exe build/*.ps1 "$HOST:AppData/Local/Temp/relay-host/"
    ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File \"%TEMP%\\relay-host\\$SCRIPT\" $*"
    ;;
  "") echo "built build/relay-host.exe" ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
esac
