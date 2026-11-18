self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.relay;
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
  toolPath = lib.makeBinPath [
    cfg.package
    cfg.hostPackage
    packages.omp
    packages.herdr
    packages.bun
    pkgs.git
    pkgs.coreutils
    pkgs.bash
  ];
  # User units run without a login shell: give them the per-user and system profiles plus Relay's tools.
  unitPath = "%h/.local/bin:%h/.nix-profile/bin:/etc/profiles/per-user/%u/bin:/run/current-system/sw/bin:/run/wrappers/bin:${toolPath}";
  # /etc/systemd/user units start for every user with a user manager (an admin account, a second
  # login): the first one to log in would hold the port. Only the listed users run them.
  onlyUsers = lib.optionalAttrs (cfg.users != [ ]) {
    ConditionUser = map (user: "|${user}") cfg.users;
  };
in
{
  options.services.relay = {
    enable = lib.mkEnableOption "Relay: the desktop app and the host daemon your phone pairs with";

    package = lib.mkOption {
      type = lib.types.package;
      default = packages.relay;
      defaultText = lib.literalExpression "relay.packages.\${system}.relay";
      description = "The Relay desktop package (the `relay` command and its .desktop entry).";
    };

    hostPackage = lib.mkOption {
      type = lib.types.package;
      default = packages.relay-host;
      defaultText = lib.literalExpression "relay.packages.\${system}.relay-host";
      description = "The relay-host package.";
    };

    users = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "alice" ];
      description = "Users who run Relay: they join the uinput group (so the phone's trackpad and keyboard can drive the session), and only they run the user units (empty: every user who logs in).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 7817;
      description = "TCP port the phone connects to (the setup wizard writes the same port to ~/.config/relay/host.json).";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Open the host port on the firewall (mDNS on 5353/udp is opened by the avahi module).";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [
      cfg.package
      cfg.hostPackage
      packages.omp
      packages.herdr
    ];

    # Phone trackpad and keyboard: a virtual input device.
    hardware.uinput.enable = true;
    users.users = lib.genAttrs cfg.users (_: {
      extraGroups = [ "uinput" ];
    });

    # The phone finds the host over mDNS (avahi-publish runs as the user).
    services.avahi = {
      enable = true;
      nssmdns4 = lib.mkDefault true;
      publish = {
        enable = true;
        userServices = true;
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    # User units, started with the user's systemd instance (the desktop app finds and restarts them
    # by these names). `loginctl enable-linger <user>` keeps them up while logged out.
    systemd.user.services.relay-host = {
      description = "Relay host (phone pairing, assistants, canvas, boards)";
      wantedBy = [ "default.target" ];
      after = [ "herdr.service" ];
      wants = [ "herdr.service" ];
      unitConfig = onlyUsers;
      # The phone's keyboard text goes through wtype in the graphical session when there is one.
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.hostPackage} serve --port ${toString cfg.port}";
        Environment = [ "PATH=${unitPath}" ];
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.user.services.herdr = {
      description = "herdr server (the terminals assistant sessions run in)";
      wantedBy = [ "default.target" ];
      unitConfig = onlyUsers;
      serviceConfig = {
        ExecStart = "${lib.getExe packages.herdr} server";
        Environment = [ "PATH=${unitPath}" ];
        Restart = "always";
        RestartSec = 2;
      };
    };
  };
}
