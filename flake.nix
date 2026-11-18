{
  description = "Relay on Linux: the desktop app and the host daemon your phone pairs with";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = "0.1.0+${self.shortRev or self.dirtyShortRev or "dev"}";
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          relay = import ./nix/packages.nix { inherit pkgs version; };
        in
        relay
        // {
          default = relay.relay;
        }
      );

      apps = forAllSystems (
        pkgs:
        let
          p = self.packages.${pkgs.stdenv.hostPlatform.system};
          app = drv: name: {
            type = "app";
            program = "${drv}/bin/${name}";
            meta.description = drv.meta.description;
          };
        in
        {
          default = app p.relay "relay";
          relay = app p.relay "relay";
          relay-host = app p.relay-host "relay-host";
          omp = app p.omp "omp";
        }
      );

      devShells = forAllSystems (
        pkgs:
        let
          p = self.packages.${pkgs.stdenv.hostPlatform.system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              p.bun
              p.omp
              p.herdr
              pkgs.nodejs_24
              pkgs.pnpm_10
              pkgs.electron_44
              pkgs.python3
              pkgs.gnumake
              pkgs.gcc
              pkgs.jq
              pkgs.git
              pkgs.avahi
              pkgs.wtype
              pkgs.wl-clipboard
              pkgs.ffmpeg
            ];
            # electron-vite and Playwright use the Nix Electron, never a downloaded one.
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_44}/libexec/electron";
          };
        }
      );

      nixosModules.default = import ./nix/module.nix self;
    };
}
