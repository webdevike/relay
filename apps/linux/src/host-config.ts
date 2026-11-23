// `~/.config/relay/host.json` (`$XDG_CONFIG_HOME/relay/host.json`): what the setup wizard writes for
// a host that is not Isaac's. `serve` flags win over it; without the file the host behaves as it
// always did (agent home from --agent-home or $HOME, every Eva feature on).
//
//   { "agentHome": "/Users/jane/Relay", "name": "Jane's Mac Studio", "port": 7817,
//     "human": "Jane",                       // optional; else the owner in `name`, else the macOS full name
//     "voice": { "provider": "gpt-live" },   // the engine calls run on; $RELAY_VOICE_PROVIDER overrides
//     "features": { "reviews": false, "voiceLocal": false, "catchup": false, "studio": false } }

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** The voice engines a host can call on; each has a layer in voice/engines.ts `VOICE_ENGINE_LAYERS`. */
export const ProviderId = z.enum(["gpt-live", "deepgram"]);
export type ProviderId = z.infer<typeof ProviderId>;
export const DEFAULT_PROVIDER: ProviderId = "gpt-live";

const HostConfigFile = z.object({
  agentHome: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  human: z.string().min(1).optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  voice: z.object({ provider: ProviderId }).optional(),
});

export interface HostConfig {
  readonly agentHome?: string;
  readonly name?: string;
  readonly port?: number;
  readonly human?: string;
  /** Only the explicit booleans of `features`. */
  readonly features: Readonly<Record<string, boolean>>;
  readonly voice?: { readonly provider: ProviderId };
}

export function relayConfigDir(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "relay");
}

/**
 * Where the desktop keeps app data, so the host's default canvases and boards dirs match it:
 * `~/Library/Application Support` on macOS, `${XDG_CONFIG_HOME:-~/.config}` elsewhere.
 */
export function supportDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support");
  const xdg = env["XDG_CONFIG_HOME"];
  return xdg === undefined || xdg === "" ? join(homedir(), ".config") : xdg;
}

/**
 * `serve`'s canvases and boards dirs when no flag or env names them, under `support`: the EvaOS
 * boards when that dir exists, or on macOS for the owner's setup (no host.json); else Relay's own,
 * which the desktop's starter profile reads too. Off macOS a host started before setup (a systemd
 * unit at login) must not create the EvaOS dir and then keep it after setup. macOS leaves boards to
 * the Relay Host wrapper (`--boards`); elsewhere they default to `Relay/boards`.
 */
export function defaultServeDirs(
  config: HostConfig | null,
  support: string = supportDir(),
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): { canvases: string; boards: string | null } {
  const evaCanvases = join(support, "EvaOS", "canvases");
  const eva = exists(evaCanvases) || (config === null && platform === "darwin");
  return {
    canvases: eva ? evaCanvases : join(support, "Relay", "canvases"),
    boards: platform === "darwin" ? null : join(support, "Relay", "boards"),
  };
}

export function hostConfigPath(): string {
  return join(relayConfigDir(), "host.json");
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** The parsed host.json; null when absent. Throws a readable error when it exists but is invalid. */
export function loadHostConfig(path: string = hostConfigPath()): HostConfig | null {
  if (!existsSync(path)) return null;
  let parsed: z.infer<typeof HostConfigFile>;
  try {
    parsed = HostConfigFile.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `${path} is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const features: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed.features ?? {}))
    if (typeof value === "boolean") features[key] = value;
  return {
    ...(parsed.agentHome === undefined ? {} : { agentHome: expandHome(parsed.agentHome) }),
    ...(parsed.name === undefined ? {} : { name: parsed.name }),
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
    ...(parsed.human === undefined ? {} : { human: parsed.human }),
    features,
    ...(parsed.voice === undefined ? {} : { voice: parsed.voice }),
  };
}

/**
 * The agent home the Relay Host app passes `serve` (apps/mac-host/RelayHost.swift): host.json's,
 * else `~/Eva` when it exists, else the home folder. CLI commands that read what the running host
 * reads use it so they see the same tasks.
 */
export function appAgentHome(config: HostConfig | null = loadHostConfig()): string {
  if (config?.agentHome !== undefined) return config.agentHome;
  const eva = join(homedir(), "Eva");
  return existsSync(eva) ? eva : homedir();
}

/**
 * Whether Isaac-specific feature `key` runs: an explicit `features.<key>` boolean wins; without a
 * host.json it is on (today's behavior); with one, it is on only when its resource is present.
 */
export function featureOn(
  config: HostConfig | null,
  key: string,
  resourcePresent: boolean,
): boolean {
  const explicit = config?.features[key];
  if (explicit !== undefined) return explicit;
  return config === null ? true : resourcePresent;
}

/** `Jane` from "Jane's Mac Studio" / "Jane’s MacBook"; null for a name without an owner. */
export function ownerOf(hostName: string): string | null {
  const match = /^(.+?)['’]s\s/.exec(hostName);
  return match?.[1]?.trim() || null;
}

/** The macOS account's full name (`id -F`), or null. */
function macFullName(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = Bun.spawnSync(["/usr/bin/id", "-F"], { stdout: "pipe", stderr: "ignore" });
    const name = out.exitCode === 0 ? out.stdout.toString().trim() : "";
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

/** The full name in a passwd line's GECOS field (`jane:x:1000:100:Jane Doe,,,:/home/jane:/bin/sh`), or null. */
export function gecosName(passwdLine: string): string | null {
  const name = passwdLine.split(":")[4]?.split(",")[0]?.trim() ?? "";
  return name === "" ? null : name;
}

/** The Linux account's full name: `getent passwd <uid>` (NSS, so LDAP/systemd-homed users too), else /etc/passwd. */
function linuxFullName(): string | null {
  if (process.platform !== "linux") return null;
  const uid = String(process.getuid?.() ?? "");
  try {
    const getent = resolveTool("getent");
    if (getent !== null) {
      const out = Bun.spawnSync([getent, "passwd", uid], { stdout: "pipe", stderr: "ignore" });
      if (out.exitCode === 0) return gecosName(out.stdout.toString().trim());
    }
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((entry) => entry.split(":")[2] === uid);
    return line === undefined ? null : gecosName(line);
  } catch {
    return null;
  }
}

/**
 * The person the assistants talk to. Without a host.json it is "Isaac" (this host's original
 * owner); with one: `human`, else the owner in the host name, else the account's full name's first
 * name (macOS `id -F`, Linux passwd GECOS), else "the user".
 */
export function resolveHuman(config: HostConfig | null, hostName: string): string {
  if (config === null) return "Isaac";
  if (config.human !== undefined) return config.human;
  const owner = ownerOf(config.name ?? hostName);
  if (owner !== null) return owner;
  const full = macFullName() ?? linuxFullName();
  return full === null ? "the user" : (full.split(/\s+/)[0] ?? full);
}

let humanName = "Isaac";
/** Set once at `serve` start. */
export function setHuman(name: string): void {
  humanName = name;
}
/** The human's display name, for prompts and messages that name them. */
export function human(): string {
  return humanName;
}

/** PATH dirs a host started by launchd/systemd/the app (no login shell) must search for herdr, omp and bun. */
export function toolDirs(): string[] {
  const home = homedir();
  const dirs = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  if (process.platform !== "linux") return dirs;
  // NixOS: the user's and the system's profiles (a systemd user unit starts with neither on PATH).
  const user = process.env["USER"] ?? process.env["LOGNAME"];
  return [
    ...dirs,
    join(home, ".nix-profile", "bin"),
    ...(user === undefined ? [] : [join("/etc", "profiles", "per-user", user, "bin")]),
    "/run/current-system/sw/bin",
    "/run/wrappers/bin",
  ];
}

/** `PATH` with `toolDirs()` appended where missing. */
export function toolPath(base: string | undefined = process.env["PATH"]): string {
  const parts = (base ?? "").split(":").filter((p) => p !== "");
  for (const dir of toolDirs()) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(":");
}

/** Absolute path of `name` on PATH plus `toolDirs()`; null when not found. */
export function resolveTool(name: string): string | null {
  return Bun.which(name, { PATH: toolPath() });
}

/**
 * The command line an agent session runs to call this host's CLI (`<cli> canvas act ...`):
 * `$RELAY_CLI` when set, else this very binary when compiled (Relay Host.app, the Nix package),
 * else `bun "<entry script>"` for a host run from source (`main.ts`) or a bundle (`.js`).
 */
export function relayCli(
  env: NodeJS.ProcessEnv = process.env,
  main: string = Bun.main,
  execPath: string = process.execPath,
): string {
  const override = env["RELAY_CLI"]?.trim();
  if (override !== undefined && override !== "") return override;
  // A `bun build --compile` binary reports its entry inside the embedded `/$bunfs` (`B:/~BUN` on Windows).
  const compiled = main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
  return !compiled && /\.(?:[cm]?[jt]s|tsx)$/.test(main) ? `bun "${main}"` : `"${execPath}"`;
}
