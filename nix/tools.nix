# The runtimes Relay drives, pinned to the versions the Macs run: Bun (the host),
# omp (the coding agent every chat and assistant runs) and herdr (the terminal multiplexer assistant
# sessions live in). omp and herdr ship prebuilt Linux binaries; on NixOS they need the Nix dynamic
# linker, which patchelf sets (both keep their payload intact, see dontStrip).
{
  lib,
  stdenv,
  fetchurl,
  bun,
  patchelf,
}:

let
  system = stdenv.hostPlatform.system;
  pick = attrs: attrs.${system} or (throw "relay: ${system} is not supported (x86_64-linux, aarch64-linux)");
  interpreter = stdenv.cc.bintools.dynamicLinker;

  # A prebuilt glibc ELF made runnable on NixOS: only the interpreter changes; no strip, no shrink,
  # so data appended after the ELF sections (Bun's compiled module graph) stays where it was.
  prebuilt =
    {
      pname,
      version,
      src,
      binName,
      meta,
    }:
    stdenv.mkDerivation {
      inherit
        pname
        version
        src
        meta
        ;
      dontUnpack = true;
      dontStrip = true;
      dontPatchELF = true;
      nativeBuildInputs = [ patchelf ];
      installPhase = ''
        runHook preInstall
        install -Dm755 $src $out/bin/${binName}
        # herdr is static (no interpreter to set); omp is a dynamically linked Bun binary.
        if patchelf --print-interpreter $out/bin/${binName} >/dev/null 2>&1; then
          patchelf --set-interpreter ${interpreter} $out/bin/${binName}
        fi
        runHook postInstall
      '';
    };
in
rec {
  # nixpkgs' bun takes its src from passthru.sources (finalAttrs), so overriding those swaps the binary.
  bun_1_4 = bun.overrideAttrs (
    finalAttrs: old: {
      version = "1.4.2";
      # src follows from passthru.sources (finalAttrs), so overriding the version alone is intended.
      __intentionallyOverridingVersion = true;
      passthru = (old.passthru or { }) // {
        sources = {
          aarch64-linux = fetchurl {
            url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
            hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac=";
          };
          x86_64-linux = fetchurl {
            url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-x64.zip";
            hash = "sha256-NjaPrvdSeHXV/6UuU81IAhdB8qg+tiCKjdZAaNQiqRM=";
          };
        };
      };
    }
  );

  omp = prebuilt rec {
    pname = "omp";
    version = "18.22.2";
    binName = "omp";
    src = pick {
      aarch64-linux = fetchurl {
        url = "https://github.com/can1357/oh-my-pi/releases/download/v${version}/omp-linux-arm64";
        hash = "sha256-gqiAugTXPxyBoSkxRH+fntiUVYGZhWTq6QDBI49FAuI=";
      };
      x86_64-linux = fetchurl {
        url = "https://github.com/can1357/oh-my-pi/releases/download/v${version}/omp-linux-x64";
        hash = "sha256-gKaSxa25xxEkuxHne9fts8+Pu6tpgNsyBty2pMspBbU=";
      };
    };
    meta = {
      description = "oh-my-pi coding agent (prebuilt ${version}), the agent behind every Relay chat";
      homepage = "https://omp.sh";
      mainProgram = "omp";
      platforms = lib.platforms.linux;
    };
  };

  herdr = prebuilt rec {
    pname = "herdr";
    version = "0.9.5";
    binName = "herdr";
    src = pick {
      aarch64-linux = fetchurl {
        url = "https://github.com/herdrdev/herdr/releases/download/v${version}/herdr-linux-aarch64";
        hash = "sha256-F9dTby2lCFlSNoDvJ53/ysjkojX05G/o2mwuxEFBiXw=";
      };
      x86_64-linux = fetchurl {
        url = "https://github.com/herdrdev/herdr/releases/download/v${version}/herdr-linux-x86_64";
        hash = "sha256-FNnovItKngEY13wyJm921GHwm0A0LrI3UpYL2J9Zkp0=";
      };
    };
    meta = {
      description = "herdr terminal multiplexer (prebuilt ${version}); Relay starts assistant sessions in it";
      homepage = "https://herdr.dev";
      mainProgram = "herdr";
      platforms = lib.platforms.linux;
    };
  };
}
