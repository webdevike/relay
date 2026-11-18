# relay-host: the Relay host daemon (apps/linux), compiled with Bun into one binary, laid out like the
# Mac bundle so its Resources lookups work: bin/relay-host, Resources/omp-extension/relay-bridge.ts
# (bundled, so it loads from ~/.omp/agent/extensions without the repo), Resources/asr/*.py.
{
  lib,
  stdenvNoCC,
  src,
  version,
  rootPnpmDeps,
  rootInstallFlags,
  widgetPnpmDeps,
  pnpm,
  pnpmWidget,
  nodejs,
  zstd,
  sqlite,
  bun,
  makeWrapper,
  # runtime tools the host shells out to
  omp,
  herdr,
  avahi,
  wtype,
  wl-clipboard,
  ffmpeg,
  git,
  lsof,
  procps,
  perl,
  util-linux,
}:

stdenvNoCC.mkDerivation {
  pname = "relay-host";
  inherit version src;

  nativeBuildInputs = [
    nodejs
    zstd
    sqlite
    bun
    makeWrapper
  ];

  # The compiled binary is Bun's runtime with the app appended: stripping or re-patching it would cut
  # the payload off. Bun from nixpkgs already carries the Nix interpreter.
  dontStrip = true;
  dontPatchELF = true;

  # The host imports packages/widget-runtime's sources (boards, canvas), which have their own lockfile.
  configurePhase = ''
    runHook preConfigure
    export HOME=$TMPDIR
    source ${./pnpm-offline.sh}
    pnpmOffline ${lib.getExe pnpm} ${rootPnpmDeps} . ${lib.escapeShellArgs rootInstallFlags} --filter '@relay/linux...'
    pnpmOffline ${lib.getExe pnpmWidget} ${widgetPnpmDeps} packages/widget-runtime --ignore-workspace
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    cd apps/linux
    bun build --compile src/main.ts --outfile relay-host
    bun build omp-extension/relay-bridge.ts --target=bun --format=esm --external '@oh-my-pi/*' --outfile relay-bridge.ts
    cd ../..
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 apps/linux/relay-host $out/bin/relay-host
    install -Dm644 apps/linux/relay-bridge.ts $out/Resources/omp-extension/relay-bridge.ts
    install -Dm644 -t $out/Resources/asr apps/linux/asr/*.py
    # Tools come after the user's PATH, so an omp they installed themselves (and keep updated) wins.
    wrapProgram $out/bin/relay-host \
      --set RELAY_CLI $out/bin/relay-host \
      --set-default RELAY_HOST_VERSION ${version} \
      --suffix PATH : ${
        lib.makeBinPath [
          omp
          herdr
          bun
          avahi
          wtype
          wl-clipboard
          ffmpeg
          git
          lsof
          procps
          perl
          util-linux
        ]
      }
    ln -s relay-host $out/bin/relay-linux
    runHook postInstall
  '';

  passthru = { inherit rootPnpmDeps widgetPnpmDeps; };

  meta = {
    description = "Relay host: phone pairing, assistants, canvas, boards, Studio and the omp agent bridge";
    homepage = "https://github.com/webdevike/relay";
    mainProgram = "relay-host";
    platforms = lib.platforms.linux;
  };
}
