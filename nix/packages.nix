# Every Relay package for one system. The repo holds three pnpm installs (the root workspace, Relay
# desktop's own workspace, packages/widget-runtime); each is a fixed-output fetch. pnpm fetches every
# platform's optional packages (`--force`), so one hash serves x86_64 and aarch64.
{ pkgs, version }:

let
  inherit (pkgs) lib;
  fs = lib.fileset;
  root = ../.;

  tools = pkgs.callPackage ./tools.nix { };
  bun = tools.bun_1_4;
  # The root workspace pins pnpm 9, which nixpkgs marks insecure; pnpm 10 installs its v9 lockfile.
  pnpmRoot = pkgs.pnpm_10;
  # Relay desktop pins pnpm 12; its lockfile (v9) installs with the newest pnpm in nixpkgs.
  pnpmDesktop = pkgs.pnpm_11 or pkgs.pnpm_10;
  electron = pkgs.electron_44;

  # Sources: tracked files minus screenshots, the phone app and the Mac-only apps; every workspace
  # manifest stays so the lockfiles still match their importers.
  src = fs.toSource {
    inherit root;
    fileset = fs.difference (fs.gitTracked root) (
      fs.unions [
        (fs.maybeMissing ../proof)
        (fs.maybeMissing ../spike)
        (fs.maybeMissing ../evals)
        (fs.maybeMissing ../ship)
        (fs.maybeMissing ../apps/desktop/e2e)
        (fs.maybeMissing ../apps/desktop/docs)
        (fs.difference ../apps/mobile (fs.maybeMissing ../apps/mobile/package.json))
        (fs.difference ../apps/mac (fs.maybeMissing ../apps/mac/package.json))
        (fs.maybeMissing ../apps/assist)
        (fs.maybeMissing ../apps/meetings-capture)
      ]
    );
  };

  # The fixed-output hashes, one per lockfile: nix/update-hashes.sh rewrites this file when a lockfile
  # changes (CI runs it on main).
  hashes = lib.importJSON ./hashes.json;

  # The root workspace's .npmrc hoists everything (the phone app's whole tree); the isolated linker
  # keeps the fetch to the packages the host and the desktop use.
  rootInstallFlags = [ "--config.node-linker=isolated" ];
  rootWorkspaces = [
    "@relay/linux..."
    "@relay/protocol..."
    "@relay/canvas-live..."
    "@relay/portrait-motion..."
    "@relay/slack-emoji..."
  ];

  rootPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "relay-root";
    inherit version src;
    pnpm = pnpmRoot;
    fetcherVersion = 4;
    pnpmWorkspaces = rootWorkspaces;
    pnpmInstallFlags = rootInstallFlags;
    hash = hashes.root;
  };

  desktopPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "relay-desktop";
    inherit version src;
    pnpm = pnpmDesktop;
    fetcherVersion = 4;
    prePnpmInstall = "cd apps/desktop";
    hash = hashes.desktop;
  };

  widgetPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "relay-widget-runtime";
    inherit version src;
    pnpm = pnpmDesktop;
    fetcherVersion = 4;
    prePnpmInstall = "cd packages/widget-runtime";
    pnpmInstallFlags = [ "--ignore-workspace" ];
    hash = hashes.widgetRuntime;
  };

  relay-host = pkgs.callPackage ./relay-host.nix {
    inherit
      src
      version
      rootPnpmDeps
      rootInstallFlags
      widgetPnpmDeps
      bun
      ;
    inherit (tools) omp herdr;
    pnpm = pnpmRoot;
    pnpmWidget = pnpmDesktop;
    nodejs = pkgs.nodejs_24;
  };

  relay = pkgs.callPackage ./relay-desktop.nix {
    inherit
      src
      version
      rootPnpmDeps
      rootInstallFlags
      desktopPnpmDeps
      widgetPnpmDeps
      electron
      bun
      relay-host
      ;
    inherit (tools) omp herdr;
    inherit pnpmRoot;
    inherit pnpmDesktop;
    nodejs = pkgs.nodejs_24;
  };
in
{
  inherit
    relay
    relay-host
    bun
    ;
  inherit (tools) omp herdr;
  relay-desktop = relay;
}
