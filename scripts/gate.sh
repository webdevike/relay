#!/usr/bin/env bash
# Green gate (D-05) for the Relay desktop app: its own pnpm workspace in apps/desktop (the app and
# the @evaos/* packages), plus the root install and @relay/widget-runtime's, which it links.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/env.sh

step() { echo "== $1 =="; }
# Run from inside apps/desktop so pnpm picks that workspace and its pnpm version.
desktop() { (cd apps/desktop && pnpm "$@"); }

step "install check"
pnpm install --frozen-lockfile
(cd packages/widget-runtime && pnpm install --frozen-lockfile --ignore-workspace)
desktop install --frozen-lockfile
step "typecheck"
desktop -r --include-workspace-root typecheck
step "lint (eslint, prettier, em-dash, spacing)"
desktop lint
step "vitest"
desktop -r --include-workspace-root test
step "build"
desktop build
node scripts/sentinel.ts before
step "e2e"
desktop e2e:run
node scripts/sentinel.ts after
if [ "${EVAOS_PROOF:-}" = "1" ]; then
  step "metrics"
  node scripts/check-metrics.ts proof/phase-1/metrics.json
fi
step "packaged smoke"
desktop package
EVAOS_PACKAGED=1 desktop e2e:run e2e/packaged.spec.ts
echo GATE GREEN
