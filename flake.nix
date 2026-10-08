{
  description = "Relay: iPhone as trackpad, keyboard, dictation and omp Agent Inbox for a Linux host";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];
    in
    {
      packages = forAllSystems (system: rec {
        relay-linux = nixpkgs.legacyPackages.${system}.callPackage ./nix/package.nix { };
        default = relay-linux;
      });

      nixosModules.default = import ./nix/module.nix self;
    };
}
