// Whether each omp profile on this Mac can still think: its model sign-ins as omp keeps them in
// `<agent dir>/agent.db` (`auth_credentials`; the default profile's dir is `~/.omp/agent`, a named
// one's `~/.omp/profiles/<name>/agent`). A credential omp gave up on (an OAuth refresh refused,
// e.g. "invalid_grant: Refresh token expired") stays in the table with a `disabled_cause`; until
// someone signs in again every turn of an omp on that profile fails before it starts ("No API key
// found for anthropic", 2026-11-19). The host reads the tables (read-only, never a token: only a
// hash of each refresh token, to see two profiles holding the same sign-in) and flags an
// assistant whose profile lost its model's sign-in before a message is lost.
//
// Two profiles holding one sign-in (a credential row copied from one agent.db to the other) break
// each other: Anthropic rotates the refresh token on every refresh (omp's refresh.ts:
// "Anthropic rotates refresh tokens on every use"), and omp's guard against a peer's rotation only
// re-reads its own agent.db, so the first profile to refresh leaves the other's token dead and omp
// there disables it. That shows as "shared". Two separate logins of the same account are two grants
// and do not interfere.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileAuth } from "@relay/protocol";
import type { SessionClock } from "../session";
import type { StatsDb } from "../stats/read";
import { openStatsDb } from "../stats/service";
import { profileLabel, providerName } from "./turn-failure";

/** One sign-in row of a profile, as the host keeps it: never the token, only a hash of its refresh token. */
export interface StoredCredential {
  readonly provider: string;
  /** omp still uses it (no `disabled_cause`). */
  readonly active: boolean;
  /** Why omp disabled it, as omp wrote it; null while active. */
  readonly cause: string | null;
  /** The account's email from omp's identity key, when it names one. */
  readonly account: string | null;
  /** sha256 of the OAuth refresh token (hex); null for an API key or a row without one. */
  readonly refresh: string | null;
}

/** What the host knows of one profile: its sign-ins (null when its agent.db could not be read) and the provider key variables its `.env` sets. */
export interface ProfileCredentials {
  readonly credentials: readonly StoredCredential[] | null;
  readonly envKeys: ReadonlySet<string>;
}

/** Every profile on this Mac by name ("" for the default profile). */
export type ProfilesCredentials = ReadonlyMap<string, ProfileCredentials>;

/** How often the host reads the tables again on its own; a failed turn reads them at once. */
export const PROFILE_AUTH_POLL_MS = 60_000;

/** The key variable omp reads for a provider's API key, where one stands in for a sign-in. */
const KEY_VAR: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
/** Providers a model is only reached through a sign-in or key of, so having none is worth flagging. */
const SIGN_IN_PROVIDERS = new Set(["anthropic", "openai-codex"]);

/** omp's agent dir for `profile` (undefined or "": the default profile) under home `home`. */
export function agentDirOf(home: string, profile?: string): string {
  return profile === undefined || profile === ""
    ? join(home, ".omp", "agent")
    : join(home, ".omp", "profiles", profile, "agent");
}

/** The default profile ("") and every named profile with an agent.db under `home`. */
export function listProfiles(home: string): string[] {
  const names = [""];
  try {
    for (const entry of readdirSync(join(home, ".omp", "profiles"), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(agentDirOf(home, entry.name), "agent.db")))
        names.push(entry.name);
    }
  } catch {
    // No named profiles.
  }
  return names;
}

/** The email in omp's identity key (`email:<address>|org:<id>`); null when it names none. */
function accountOf(identity: unknown): string | null {
  if (typeof identity !== "string") return null;
  const match = /(?:^|\|)email:([^|]+)/.exec(identity);
  return match?.[1] ?? null;
}

/** The rows of one auth_credentials table as the host keeps them (`StoredCredential`). */
export function credentialsOf(rows: readonly Record<string, unknown>[]): StoredCredential[] {
  return rows.flatMap((row) => {
    const provider = row["provider"];
    if (typeof provider !== "string" || provider.length === 0) return [];
    const cause = typeof row["disabled_cause"] === "string" ? row["disabled_cause"] : null;
    let refresh: string | null = null;
    if (row["credential_type"] === "oauth" && typeof row["data"] === "string") {
      try {
        const data = JSON.parse(row["data"]) as { refresh?: unknown };
        if (typeof data.refresh === "string" && data.refresh.length > 0)
          refresh = createHash("sha256").update(data.refresh).digest("hex");
      } catch {
        // A row omp cannot read either.
      }
    }
    return [{ provider, active: cause === null, cause, account: accountOf(row["identity_key"]), refresh }];
  });
}

/** Reads one agent.db's sign-ins; null when it is missing or unreadable. */
export async function readCredentials(path: string): Promise<StoredCredential[] | null> {
  if (!existsSync(path)) return null;
  let db: StatsDb | null = null;
  try {
    db = await openStatsDb(path);
    return credentialsOf(
      db.all(
        "SELECT provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials ORDER BY id ASC",
      ),
    );
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** The provider key variables `<agentDir>/.env` sets (to a value). */
export function envKeysOf(agentDir: string): Set<string> {
  const found = new Set<string>();
  try {
    const text = readFileSync(join(agentDir, ".env"), "utf8");
    for (const name of Object.values(KEY_VAR))
      if (new RegExp(`^${name}=.+`, "m").test(text)) found.add(name);
  } catch {
    // No .env.
  }
  return found;
}

/** omp's disable cause in a few words: an OAuth error's description ("Refresh token expired"), else the cause without omp's prefix. */
export function causeWords(cause: string): string {
  const described = /"error_description"\s*:\s*"([^"]+)"/.exec(cause)?.[1];
  const words = (described ?? cause.replace(/^oauth refresh failed:\s*/i, "")).replace(/\s+/g, " ").trim();
  return words.length > 160 ? `${words.slice(0, 159)}…` : words;
}

/**
 * How profile `profile` (undefined: default) stands for `provider` (the agent's model's; undefined:
 * the first provider it lost every sign-in of, if any). Undefined when nothing can be said: the
 * profile's agent.db was not read, or no provider is known and nothing is broken.
 */
export function profileAuth(
  all: ProfilesCredentials,
  profile: string | undefined,
  provider: string | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): ProfileAuth | undefined {
  const own = all.get(profile ?? "");
  const rows = own?.credentials;
  if (own === undefined || rows === null || rows === undefined) return undefined;
  const target =
    provider ??
    rows.find((r) => !rows.some((other) => other.provider === r.provider && other.active))?.provider;
  if (target === undefined) return undefined;
  const base = { ...(profile === undefined ? {} : { profile }), provider: target };
  const name = providerName(target);
  const where = profileLabel(profile);
  const active = rows.filter((r) => r.provider === target && r.active);
  if (active.length > 0) {
    for (const row of active) {
      if (row.refresh === null) continue;
      for (const [other, theirs] of all) {
        if (other === (profile ?? "")) continue;
        if (!(theirs.credentials ?? []).some((r) => r.active && r.refresh === row.refresh)) continue;
        return {
          ...base,
          state: "shared",
          detail: `${name} sign-in in ${where} is a copy of the one in ${profileLabel(other === "" ? undefined : other)}. ${name} replaces it on every refresh, so the first profile to refresh signs the other out. Sign in again here to give this profile its own.`,
          ...(row.account === null ? {} : { account: row.account }),
        };
      }
    }
    const account = active[0]?.account ?? null;
    return { ...base, state: "ok", ...(account === null ? {} : { account }) };
  }
  const keyVar = KEY_VAR[target];
  if (keyVar !== undefined && ((env[keyVar] ?? "") !== "" || own.envKeys.has(keyVar)))
    return { ...base, state: "ok" };
  const disabled = rows.filter((r) => r.provider === target);
  const last = disabled.at(-1);
  if (last !== undefined) {
    return {
      ...base,
      state: "signed_out",
      detail: `${name} sign-in for ${where} stopped working (${causeWords(last.cause ?? "disabled")}). Sign in again under ${where}.`,
      ...(last.account === null ? {} : { account: last.account }),
    };
  }
  if (!SIGN_IN_PROVIDERS.has(target)) return undefined;
  return { ...base, state: "missing", detail: `${where[0]?.toUpperCase() ?? ""}${where.slice(1)} has no ${name} sign-in. Sign in under ${where}.` };
}

export interface ProfileAuthMonitorDeps {
  /** The home omp keeps `.omp` in. */
  readonly home: string;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** Called when any profile's sign-ins changed since the last read. */
  readonly onChange: () => void;
  /** Reads one agent.db (`readCredentials`). */
  readonly read?: (path: string) => Promise<StoredCredential[] | null>;
  /** The host's environment, for provider key variables. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Keeps every profile's sign-ins as last read: on start, every `PROFILE_AUTH_POLL_MS`, and at once
 * when a turn failed for its sign-in (`refresh`). A change (a credential disabled, a new login, a
 * copy appearing) calls `onChange`, so the assistants' rows go out again before a message is lost.
 */
export class ProfileAuthMonitor {
  private all: ProfilesCredentials = new Map();
  private seen = "";
  private cancel: (() => void) | null = null;
  private reading: Promise<void> | null = null;

  constructor(private readonly deps: ProfileAuthMonitorDeps) {}

  start(): void {
    void this.refresh();
    const tick = (): void => {
      this.cancel = this.deps.clock.after(PROFILE_AUTH_POLL_MS, () => {
        void this.refresh().finally(tick);
      });
    };
    tick();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** How `profile` stands for `provider` as last read (`profileAuth`). */
  auth(profile: string | undefined, provider: string | undefined): ProfileAuth | undefined {
    return profileAuth(this.all, profile, provider, this.deps.env ?? {});
  }

  /** Reads every profile again; one read at a time. */
  refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(): Promise<void> {
    const read = this.deps.read ?? readCredentials;
    const next = new Map<string, ProfileCredentials>();
    for (const name of listProfiles(this.deps.home)) {
      const dir = agentDirOf(this.deps.home, name);
      next.set(name, { credentials: await read(join(dir, "agent.db")), envKeys: envKeysOf(dir) });
    }
    const key = JSON.stringify([...next].map(([name, p]) => [name, p.credentials, [...p.envKeys]]));
    this.all = next;
    if (key === this.seen) return;
    this.seen = key;
    for (const [name] of next) {
      for (const provider of new Set((next.get(name)?.credentials ?? []).map((r) => r.provider))) {
        const auth = profileAuth(next, name === "" ? undefined : name, provider, this.deps.env ?? {});
        if (auth !== undefined && auth.state !== "ok")
          this.deps.log(`profile auth: ${name === "" ? "default" : name} ${provider} ${auth.state}${auth.detail === undefined ? "" : `: ${auth.detail}`}`);
      }
    }
    // The first read too: rows listed before it went out without `auth`.
    this.deps.onChange();
  }
}
