self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.relay-linux;
in
{
  options.services.relay-linux = {
    enable = lib.mkEnableOption "the Relay host daemon (iPhone trackpad, keyboard, dictation, drops, omp Agent Inbox)";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.relay-linux;
      defaultText = lib.literalExpression "relay.packages.\${system}.relay-linux";
      description = "The relay-linux package to run.";
    };

    users = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "alice" ];
      description = "Users added to the uinput group so the daemon running as them can move the pointer and type.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 7817;
      description = "TCP port the phone connects to.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Open the daemon port (mDNS on 5353 is opened by the avahi module).";
    };

    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "--agent-home"
        "/home/alice/code"
      ];
      description = "Extra arguments for `relay-linux serve`.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
    # Stable path for the omp extension symlink: /run/current-system/sw/share/relay-linux/omp-extension.
    environment.pathsToLink = [ "/share/relay-linux" ];

    hardware.uinput.enable = true;
    users.users = lib.genAttrs cfg.users (_: {
      extraGroups = [ "uinput" ];
    });

    # avahi-publish runs as the user, so the daemon must accept user-published services.
    services.avahi = {
      enable = true;
      publish = {
        enable = true;
        userServices = true;
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    # A user unit inside the graphical session: wtype and wl-clipboard need WAYLAND_DISPLAY, and the
    # omp bridge socket lives in the user's XDG_RUNTIME_DIR.
    systemd.user.services.relay-linux = {
      description = "Relay host daemon";
      wantedBy = [ "graphical-session.target" ];
      partOf = [ "graphical-session.target" ];
      after = [ "graphical-session.target" ];
      serviceConfig = {
        ExecStart = lib.escapeShellArgs (
          [
            (lib.getExe cfg.package)
            "serve"
            "--port"
            (toString cfg.port)
          ]
          ++ cfg.extraArgs
        );
        Restart = "on-failure";
        RestartSec = 2;
      };
    };
  };
}
