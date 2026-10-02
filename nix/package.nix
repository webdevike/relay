{
  lib,
  stdenvNoCC,
  fetchurl,
  bun,
  makeWrapper,
  avahi,
  wtype,
  wl-clipboard,
}:

let
  # The daemon's only third-party runtime dependency; version and integrity match pnpm-lock.yaml.
  zod = fetchurl {
    url = "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz";
    hash = "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==";
  };
in
stdenvNoCC.mkDerivation {
  pname = "relay-linux";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../apps/linux/src
      ../apps/linux/omp-extension
      ../apps/linux/package.json
      ../packages/protocol/src
      ../packages/protocol/package.json
    ];
  };

  nativeBuildInputs = [
    bun
    makeWrapper
  ];

  # Lay out node_modules the way pnpm would for these two packages, then bundle main.ts and
  # everything it imports into one file; bun:ffi, bun and node: builtins stay external.
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    mkdir -p node_modules/zod node_modules/@relay
    tar -xzf ${zod} -C node_modules/zod --strip-components=1
    ln -s ../../packages/protocol node_modules/@relay/protocol
    bun build apps/linux/src/main.ts --target bun --outfile relay-linux.js
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 relay-linux.js $out/lib/relay-linux/relay-linux.js
    mkdir -p $out/share/relay-linux
    cp -r apps/linux/omp-extension $out/share/relay-linux/omp-extension
    makeWrapper ${lib.getExe bun} $out/bin/relay-linux \
      --add-flags $out/lib/relay-linux/relay-linux.js \
      --prefix PATH : ${
        lib.makeBinPath [
          avahi
          wtype
          wl-clipboard
        ]
      }
    runHook postInstall
  '';

  meta = {
    description = "Relay host daemon: iPhone trackpad, keyboard, dictation, drops and omp Agent Inbox";
    homepage = "https://github.com/webdevike/relay";
    mainProgram = "relay-linux";
    platforms = lib.platforms.linux;
  };
}
