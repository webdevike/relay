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
  # The daemon's third-party runtime dependencies; versions and integrity match pnpm-lock.yaml.
  npmDeps = {
    zod = fetchurl {
      url = "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz";
      hash = "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==";
    };
    yjs = fetchurl {
      url = "https://registry.npmjs.org/yjs/-/yjs-13.6.33.tgz";
      hash = "sha512-q/UYvr1gOk4XII+Cu1CW2dINjYqJJFifTzogEaIARznrvX7uOlHsdTEXcnOBMuIsrCGEEKdNxi74kyMLZlKVfw==";
    };
    y-protocols = fetchurl {
      url = "https://registry.npmjs.org/y-protocols/-/y-protocols-1.0.7.tgz";
      hash = "sha512-YSVsLoXxO67J6eE/nV4AtFtT3QEotZf5sK5BHxFBXso7VDUT3Tx07IfA6hsu5Q5OmBdMkQVmFZ9QOA7fikWvnw==";
    };
    lib0 = fetchurl {
      url = "https://registry.npmjs.org/lib0/-/lib0-0.2.119.tgz";
      hash = "sha512-vh+TiejVy8Xm+hCdnRfn9BthGNvNUZdEXltNjVZL3TzRIKP3s1lnQh8pWd/Q0wCgY0FPAGVVjFF4ZiHUV3LFgA==";
    };
    "isomorphic.js" = fetchurl {
      url = "https://registry.npmjs.org/isomorphic.js/-/isomorphic.js-0.2.5.tgz";
      hash = "sha512-PIeMbHqMt4DnUP3MA/Flc0HElYjMXArsw1qwJZcm9sqR8mq3l8NYizFMty0pWwE/tzIGH3EKK5+jes5mAr85yw==";
    };
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
      ../packages/canvas-live/src
      ../packages/canvas-live/package.json
      # The live canvas web client, prebuilt and committed; apps/linux/src/canvas/page.ts embeds it as text.
      ../packages/canvas-web/generated/canvas.html
    ];
  };

  nativeBuildInputs = [
    bun
    makeWrapper
  ];

  # Lay out a hoisted node_modules for the workspace packages and npm dependencies, then bundle
  # main.ts and everything it imports into one file; bun:ffi, bun and node: builtins stay external.
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    mkdir -p node_modules/@relay
    ${lib.concatStrings (
      lib.mapAttrsToList (name: tgz: ''
        mkdir -p node_modules/${name}
        tar -xzf ${tgz} -C node_modules/${name} --strip-components=1
      '') npmDeps
    )}
    ln -s ../../packages/protocol node_modules/@relay/protocol
    ln -s ../../packages/canvas-live node_modules/@relay/canvas-live
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
