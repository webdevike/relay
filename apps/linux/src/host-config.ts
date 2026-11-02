// `~/.config/relay/host.json` (`$XDG_CONFIG_HOME/relay/host.json`): what the setup wizard writes for
// a host that is not Isaac's. `serve` flags win over it; without the file the host behaves as it
// always did (agent home from --agent-home or $HOME, every Eva feature on).
//
//   { "agentHome": "/Users/jane/Relay", "name": "Jane's Mac Studio", "port": 7817,
//     "human": "Jane",                       // optional; else the owner in `name`, else the macOS full name
//     "features": { "reviews": false, "voiceLocal": false, "catchup": false, "studio": false } }

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const HostConfigFile = z.object({
  agentHome: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  human: z.string().min(1).optional(),
  features: z.record(z.string(), z.unknown()).optional(),
});

export interface HostConfig {
  readonly agentHome?: string;
  readonly name?: string;
  readonly port?: number;
  readonly human?: string;
  /** Only the explicit booleans of `features`. */
  readonly features: Readonly<Record<string, boolean>>;
}

export function relayConfigDir(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "relay");
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
    throw new Error(`${path} is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const features: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed.features ?? {})) if (typeof value === "boolean") features[key] = value;
  return {
    ...(parsed.agentHome === undefined ? {} : { agentHome: expandHome(parsed.agentHome) }),
    ...(parsed.name === undefined ? {} : { name: parsed.name }),
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
    ...(parsed.human === undefined ? {} : { human: parsed.human }),
    features,
  };
}

/**
 * Whether Isaac-specific feature `key` runs: an explicit `features.<key>` boolean wins; without a
 * host.json it is on (today's behavior); with one, it is on only when its resource is present.
 */
export function featureOn(config: HostConfig | null, key: string, resourcePresent: boolean): boolean {
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

/**
 * The person the assistants talk to. Without a host.json it is "Isaac" (this host's original
 * owner); with one: `human`, else the owner in the host name, else the macOS full name's first
 * name, else "the user".
 */
export function resolveHuman(config: HostConfig | null, hostName: string): string {
  if (config === null) return "Isaac";
  if (config.human !== undefined) return config.human;
  const owner = ownerOf(config.name ?? hostName);
  if (owner !== null) return owner;
  const full = macFullName();
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

/** PATH dirs a host started by launchd/the app (no login shell) must search for herdr, omp and bun. */
export function toolDirs(): string[] {
  const home = homedir();
  return [join(home, ".local", "bin"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
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
