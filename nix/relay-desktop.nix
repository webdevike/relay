# relay: Relay desktop (apps/desktop), built from source with electron-vite and run on the nixpkgs
# Electron as the stable app (EVAOS_STABLE=1: live data, connects to the host, ~/.config/Relay Desktop).
# The launcher puts relay-host, omp, herdr and bun on PATH after the user's own,
# and the app starts the host itself on first run (resources/setup/start-host.sh).
{
  lib,
  stdenv,
  src,
  version,
  rootPnpmDeps,
  rootInstallFlags,
  desktopPnpmDeps,
  widgetPnpmDeps,
  pnpmRoot,
  pnpmDesktop,
  nodejs,
  electron,
  bun,
  relay-host,
  omp,
  herdr,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  python3,
  zstd,
  sqlite,
  jq,
  git,
  xdg-utils,
  procps,
  iproute2,
  util-linux,
}:

stdenv.mkDerivation {
  pname = "relay";
  inherit version src;

  nativeBuildInputs = [
    nodejs
    python3
    zstd
    sqlite
    makeWrapper
    copyDesktopItems
  ];

  env = {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    npm_config_nodedir = electron.headers;
  };

  # One offline pnpm install per lockfile, from its fixed-output store.
  configurePhase = ''
    runHook preConfigure
    export HOME=$TMPDIR
    source ${./pnpm-offline.sh}

    pnpmOffline ${lib.getExe pnpmRoot} ${rootPnpmDeps} . ${lib.escapeShellArgs rootInstallFlags} \
      --filter '@relay/protocol...' --filter '@relay/canvas-live...' \
      --filter '@relay/portrait-motion...' --filter '@relay/slack-emoji...' --filter '@relay/linux...'
    pnpmOffline ${lib.getExe pnpmDesktop} ${widgetPnpmDeps} packages/widget-runtime --ignore-workspace
    pnpmOffline ${lib.getExe pnpmDesktop} ${desktopPnpmDeps} apps/desktop
    patchShebangs apps/desktop/node_modules packages/widget-runtime/node_modules node_modules
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    (cd apps/desktop && node node_modules/electron-vite/bin/electron-vite.js build)

    # The app's runtime dependencies (externalized by electron-vite): a production-only reinstall of
    # the app's workspace, with node-pty compiled against the Electron headers.
    rm -rf apps/desktop/node_modules
    pnpmOffline ${lib.getExe pnpmDesktop} ${desktopPnpmDeps} apps/desktop --prod --filter @evaos/desktop
    pty=$(readlink -f apps/desktop/node_modules/node-pty)
    (cd "$pty" && node ${nodejs}/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild)
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    app=$out/share/relay/app
    mkdir -p $app
    cp -a apps/desktop/out apps/desktop/resources apps/desktop/package.json $app/
    cp -a apps/desktop/node_modules $app/node_modules
    rm -rf $app/resources/RelayHost
    find $app/node_modules -name '*.o' -delete

    makeWrapper ${lib.getExe electron} $out/bin/relay \
      --add-flags $app \
      --set EVAOS_STABLE 1 \
      --set RELAY_SETUP_DIR $app/resources/setup \
      --set RELAY_HOST_VERSION ${version} \
      --set RELAY_OMP_EXTENSION_DIR ${relay-host}/Resources/omp-extension \
      --set-default ELECTRON_OZONE_PLATFORM_HINT auto \
      --suffix PATH : ${
        lib.makeBinPath [
          relay-host
          omp
          herdr
          bun
          jq
          git
          xdg-utils
          procps
          iproute2
          util-linux
        ]
      }
    install -Dm644 apps/desktop/resources/icon.png $out/share/icons/hicolor/512x512/apps/relay.png
    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "relay";
      desktopName = "Relay";
      comment = "Your assistants, canvas and phone in one place";
      exec = "relay %U";
      icon = "relay";
      categories = [
        "Office"
        "Development"
      ];
      mimeTypes = [ "x-scheme-handler/relay" ];
      startupWMClass = "Relay";
    })
  ];

  passthru = { inherit rootPnpmDeps desktopPnpmDeps widgetPnpmDeps; };

  meta = {
    description = "Relay desktop: chats with your assistants, canvas, boards, Files, Studio and phone pairing";
    homepage = "https://github.com/webdevike/relay";
    mainProgram = "relay";
    platforms = lib.platforms.linux;
  };
}
