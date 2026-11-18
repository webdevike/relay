# shellcheck shell=bash
# pnpmOffline <pnpm> <deps> <dir> [install flags...]: an offline `pnpm install` in <dir> from a
# fetchPnpmDeps store (fetcherVersion 4), what nixpkgs' pnpmConfigHook does for one lockfile. The
# Relay repo has several lockfiles, so its derivations call this once per lockfile.
pnpmOffline() {
  local pnpm=$1 deps=$2 dir=$3
  shift 3
  local store
  store=$(mktemp -d)
  tar --zstd -xf "$deps/pnpm-store.tar.zst" -C "$store"
  chmod -R +w "$store"
  if [ -f "$store/v11/index.db.sql" ]; then
    sqlite3 "$store/v11/index.db" <"$store/v11/index.db.sql"
    rm "$store/v11/index.db.sql"
  fi
  (
    cd "$dir"
    export pnpm_config_pm_on_fail=ignore pnpm_config_trust_lockfile=true \
      npm_config_manage_package_manager_versions=false pnpm_config_manage_package_manager_versions=false
    "$pnpm" install --offline --ignore-scripts --frozen-lockfile \
      --store-dir "$store" --config.package-import-method=clone-or-copy "$@"
  )
}
