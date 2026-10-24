import os from "node:os";
import path from "node:path";

/** Where published updates live: `updates/<runtimeVersion>/<platform>/<epoch ms>/`, outside any worktree. */
export const DEFAULT_DATA_ROOT = path.join(os.homedir(), "Library", "Application Support", "Relay OTA");
/** Loopback port the LaunchAgent listens on; Tailscale serve fronts it. */
export const DEFAULT_PORT = 8477;
/** Tailnet-only HTTPS (`tailscale serve --https=8447`); app.json `updates.url` points here. */
export const DEFAULT_PUBLIC_URL = "https://isaacs-mac-mini.tail80fdb0.ts.net:8447";

export interface ServerConfig {
  dataRoot: string;
  port: number;
  /** Origin written into manifest asset URLs, without a trailing slash. */
  publicUrl: string;
}

export function serverConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    dataRoot: env["RELAY_OTA_DATA"] ?? DEFAULT_DATA_ROOT,
    port: Number(env["RELAY_OTA_PORT"] ?? DEFAULT_PORT),
    publicUrl: (env["RELAY_OTA_PUBLIC_URL"] ?? DEFAULT_PUBLIC_URL).replace(/\/+$/, ""),
  };
}
