#!/usr/bin/env bash
# Green gate (D-05). Phases close only when this exits 0.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/env.sh

step() { echo "== $1 =="; }

step "install check"
pnpm install --frozen-lockfile
step "typecheck"
pnpm -r typecheck
step "eslint"
pnpm exec eslint .
step "prettier"
pnpm exec prettier --check .
step "em-dash lint"
node scripts/lint-em-dash.ts
step "vitest"
pnpm exec vitest run
step "build"
pnpm -C apps/desktop build
node scripts/sentinel.ts before
step "e2e"
pnpm -C apps/desktop e2e:run
node scripts/sentinel.ts after
# packaged smoke
echo GATE GREEN
