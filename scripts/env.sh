# Source me: puts a repo-local pnpm (corepack shim) on PATH without touching global config.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if [ ! -x "$REPO/.tools/bin/pnpm" ]; then
  mkdir -p "$REPO/.tools/bin"
  (cd "$REPO" && corepack enable pnpm --install-directory "$REPO/.tools/bin")
fi
export PATH="$REPO/.tools/bin:$PATH"
