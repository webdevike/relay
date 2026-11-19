import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDirOf, ProfileAuthMonitor } from "../src/assistant/profile-auth";
import type { SessionClock } from "../src/session";

// node:sqlite is newer than the @types/node this package pins, so its shape is declared here (as in stats.test.ts).
interface WritableDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: (string | number | null)[]): void };
  close(): void;
}
const nodeSqlite = "node:sqlite";
const { DatabaseSync } = (await import(nodeSqlite)) as { DatabaseSync: new (path: string) => WritableDb };

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

interface Row {
  provider: string;
  type?: "oauth" | "api_key";
  refresh?: string;
  email?: string;
  disabled?: string;
}

/** An omp agent.db for `profile` (undefined: default) holding `rows`, as omp's auth_credentials table lays them out. */
function profileDb(home: string, profile: string | undefined, rows: Row[]): void {
  const dir = agentDirOf(home, profile);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "agent.db"));
  db.exec(
    "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)",
  );
  const insert = db.prepare(
    "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows)
    insert.run(
      row.provider,
      row.type ?? "oauth",
      JSON.stringify({ access: "secret-access", refresh: row.refresh ?? "secret-refresh", expires: 1 }),
      row.disabled ?? null,
      row.email === undefined ? null : `email:${row.email}|org:o1`,
    );
  db.close();
}

const clock: SessionClock = { now: () => 0, after: () => () => undefined };

async function monitor(home: string, env: Record<string, string> = {}) {
  const logs: string[] = [];
  let changes = 0;
  const m = new ProfileAuthMonitor({
    home,
    clock,
    log: (line) => logs.push(line),
    onChange: () => {
      changes += 1;
    },
    env,
  });
  await m.refresh();
  return { m, logs, changes: () => changes };
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-home-"));
  homes.push(dir);
  return dir;
}

describe("profile sign-in health", () => {
  it("flags a profile whose Claude sign-in omp disabled, with omp's reason and the account", async () => {
    const h = home();
    profileDb(h, undefined, [{ provider: "anthropic", refresh: "R-default", email: "ike@x.com" }]);
    profileDb(h, "personal", [
      {
        provider: "anthropic",
        email: "ike@x.com",
        disabled:
          'oauth refresh failed: OAuthError: anthropic token refresh failed: 400 {"error": "invalid_grant", "error_description": "Refresh token expired"}',
      },
    ]);
    const { m, logs } = await monitor(h);
    expect(m.auth("personal", "anthropic")).toEqual({
      profile: "personal",
      provider: "anthropic",
      state: "signed_out",
      detail:
        "Claude sign-in for the personal profile stopped working (Refresh token expired). Sign in again under the personal profile.",
      account: "ike@x.com",
    });
    expect(m.auth(undefined, "anthropic")).toMatchObject({ state: "ok", account: "ike@x.com" });
    // With no model known, the provider it lost is the one reported.
    expect(m.auth("personal", undefined)).toMatchObject({ provider: "anthropic", state: "signed_out" });
    expect(logs.join("\n")).toContain("personal anthropic signed_out");
  });

  it("flags two profiles holding a copy of one sign-in, and not two separate logins of the same account", async () => {
    const h = home();
    profileDb(h, undefined, [{ provider: "anthropic", refresh: "R-copied", email: "ike@x.com" }]);
    profileDb(h, "personal", [{ provider: "anthropic", refresh: "R-copied", email: "ike@x.com" }]);
    profileDb(h, "work", [{ provider: "anthropic", refresh: "R-own", email: "ike@x.com" }]);
    const { m } = await monitor(h);
    expect(m.auth("personal", "anthropic")).toMatchObject({ state: "shared", account: "ike@x.com" });
    expect(m.auth("personal", "anthropic")?.detail).toContain("is a copy of the one in the default profile");
    expect(m.auth(undefined, "anthropic")?.detail).toContain("is a copy of the one in the personal profile");
    expect(m.auth("work", "anthropic")).toMatchObject({ state: "ok" });
  });

  it("says a profile has no Claude sign-in unless an API key stands in", async () => {
    const h = home();
    profileDb(h, "personal", [{ provider: "openai-codex", refresh: "R-codex" }]);
    const without = await monitor(h);
    expect(without.m.auth("personal", "anthropic")).toMatchObject({ state: "missing" });
    expect(without.m.auth("personal", "openai-codex")).toMatchObject({ state: "ok" });
    writeFileSync(join(agentDirOf(h, "personal"), ".env"), "ANTHROPIC_API_KEY=sk-test\n");
    const withKey = await monitor(h);
    expect(withKey.m.auth("personal", "anthropic")).toMatchObject({ state: "ok" });
  });

  it("calls onChange when a later read finds a sign-in changed, and not when nothing did", async () => {
    const h = home();
    profileDb(h, "personal", [{ provider: "anthropic", refresh: "R1" }]);
    const { m, changes } = await monitor(h);
    expect(changes()).toBe(1);
    await m.refresh();
    expect(changes()).toBe(1);
    rmSync(join(agentDirOf(h, "personal"), "agent.db"));
    profileDb(h, "personal", [{ provider: "anthropic", refresh: "R1", disabled: "oauth refresh failed: 400" }]);
    await m.refresh();
    expect(changes()).toBe(2);
    expect(m.auth("personal", "anthropic")).toMatchObject({ state: "signed_out" });
  });
});
