import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantRegistry, idFromTitle, RETIRED_FILE, threadFile, WATCH_SETTLE_MS } from "../src/assistant/admin";
import { handleAssistantAdmin } from "../src/assistant/http";
import { primeFirstLine } from "../src/assistant/onboarding";
import { REGISTRY_FILE, RegistryError, type AssistantAgentConfig } from "../src/assistant/registry";
import { primeFile } from "../src/assistant/service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOVA = { id: "nova", title: "Nova", scope: "Personal", liveVoice: "marin", avatar: { style: "micah", seed: "nova-17", options: { hair: ["fonze"] } }, note: "kept" };
const ASTRA = { id: "astra", title: "Astra", scope: "eCard Systems work", avatar: "astra-2" };

/** An agent home with a registry (`agents`), a thread template and, with `eva`, Eva's `work/eva/agents/`. */
function home(agents: unknown[] = [NOVA, ASTRA], eva = false): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-admin-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".omp", "assistant"), { recursive: true });
  writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ version: 2, agents }, null, 2));
  writeFileSync(join(dir, ".omp", "assistant", "thread.template.md"), "# Thread memory\n\n## About {{userName}} lately\n- (nothing yet)\n");
  if (eva) mkdirSync(join(dir, "work", "eva", "agents"), { recursive: true });
  return dir;
}

function registry(agentHome: string) {
  const logs: string[] = [];
  const changes: (readonly AssistantAgentConfig[])[] = [];
  const admin = new AssistantRegistry({ agentHome, userName: () => "Jane", cli: "relay-linux", log: (line) => logs.push(line), now: () => Date.UTC(2026, 10, 4) });
  admin.onChange = (agents) => changes.push(agents);
  return { admin, logs, changes };
}

const raw = (agentHome: string): { version?: number; agents: Record<string, unknown>[] } => JSON.parse(readFileSync(join(agentHome, REGISTRY_FILE), "utf8")) as { version?: number; agents: Record<string, unknown>[] };

describe("idFromTitle", () => {
  it("makes a registry id from a name", () => {
    expect(idFromTitle("Vega")).toBe("vega");
    expect(idFromTitle("  Drive Buddy! ")).toBe("drive-buddy");
    expect(idFromTitle("Zoë")).toBe("zoe");
    expect(idFromTitle("4x4")).toBe("a-4x4");
    expect(idFromTitle("!!!")).toBe("");
  });
});

describe("AssistantRegistry.create", () => {
  it("adds the entry with a micah face of its own and scaffolds the first-run prime and thread memory", () => {
    const dir = home();
    const { admin, changes } = registry(dir);
    const entry = admin.create({ title: "Vega", scope: "Driving and the car" });
    expect(entry).toEqual({ id: "vega", title: "Vega", scope: "Driving and the car", avatar: { style: "micah", seed: "vega", colors: { paper: "#ebfbee", accent: "#2f9e44" } } });
    // Other entries and fields this code does not know stay as written.
    expect(raw(dir)).toEqual({ version: 2, agents: [NOVA, ASTRA, entry] });
    expect(changes.at(-1)?.map((agent) => agent.id)).toEqual(["nova", "astra", "vega"]);
    const prime = readFileSync(join(dir, primeFile("vega")), "utf8");
    expect(prime.startsWith(primeFirstLine("Vega", "Jane"))).toBe(true);
    expect(prime).toContain("Don't run a questionnaire");
    expect(prime).toContain("relay-linux assistant set --agent vega --scope");
    expect(prime).toContain("Nova (nova): Personal; Astra (astra): eCard Systems work");
    expect(prime).toContain('They said it is for: "Driving and the car"');
    expect(readFileSync(join(dir, "work", "agents", "vega", "thread.md"), "utf8")).toContain("## About Jane lately");
  });

  it("keeps Eva's memory layout and an existing prime", () => {
    const dir = home([NOVA], true);
    mkdirSync(join(dir, ".omp", "assistant", "agents", "vega"), { recursive: true });
    writeFileSync(join(dir, primeFile("vega")), "You are Vega, back again.");
    registry(dir).admin.create({ title: "Vega" });
    expect(threadFile(dir, "vega")).toBe(join("work", "eva", "agents", "vega", "thread.md"));
    expect(existsSync(join(dir, "work", "eva", "agents", "vega", "thread.md"))).toBe(true);
    expect(readFileSync(join(dir, primeFile("vega")), "utf8")).toBe("You are Vega, back again.");
  });

  it("refuses a taken id or title and an id it cannot make, writing nothing", () => {
    const dir = home();
    const { admin } = registry(dir);
    expect(() => admin.create({ title: "Nova" })).toThrow(RegistryError);
    expect(() => admin.create({ id: "nova2", title: "nova" })).toThrow(/called nova already exists/);
    expect(() => admin.create({ title: "???" })).toThrow(/cannot make an id/);
    expect(() => admin.create({ title: "" })).toThrow(RegistryError);
    expect(() => admin.create({ id: "Bad Id", title: "Bad" })).toThrow(RegistryError);
    expect(raw(dir).agents).toEqual([NOVA, ASTRA]);
    expect(existsSync(join(dir, primeFile("nova")))).toBe(false);
  });

  it("picks a seed no other agent draws with", () => {
    const dir = home([{ id: "nova", title: "Nova", avatar: "vega" }, { id: "astra", title: "Astra", avatar: { style: "micah", seed: "vega-2" } }]);
    expect(registry(dir).admin.create({ title: "Vega" })["avatar"]).toMatchObject({ seed: "vega-3" });
  });
});

describe("AssistantRegistry.update", () => {
  it("reports each changed field, clears with null and leaves unknown fields alone", () => {
    const dir = home();
    const { admin } = registry(dir);
    expect(admin.update("nova", { scope: "Everything personal", liveVoice: "cedar", model: "anthropic/claude-sonnet-4-5" })).toEqual([
      { field: "scope", from: "Personal", to: "Everything personal" },
      { field: "liveVoice", from: "marin", to: "cedar" },
      { field: "model", from: null, to: "anthropic/claude-sonnet-4-5" },
    ]);
    expect(admin.update("nova", { model: null })).toEqual([{ field: "model", from: "anthropic/claude-sonnet-4-5", to: null }]);
    expect(admin.update("nova", { scope: "Everything personal" })).toEqual([]);
    expect(raw(dir).agents[0]).toEqual({ ...NOVA, scope: "Everything personal", liveVoice: "cedar" });
  });

  it("validates: unknown agent or field, live voice outside the catalog, a face or title another agent has", () => {
    const dir = home();
    const { admin } = registry(dir);
    expect(() => admin.update("vega", { scope: "x" })).toThrow(/no assistant vega/);
    expect(() => admin.update("nova", { id: "other" })).toThrow(RegistryError);
    expect(() => admin.update("nova", { liveVoice: "robot" })).toThrow(/liveVoice must be one of/);
    expect(() => admin.update("nova", { avatar: "astra-2" })).toThrow(/already Astra's/);
    expect(() => admin.update("nova", { title: "Astra" })).toThrow(/called Astra already exists/);
    expect(() => admin.update("nova", { model: "two words" })).toThrow(/model must be/);
    expect(raw(dir).agents).toEqual([NOVA, ASTRA]);
  });
});

describe("AssistantRegistry.retire", () => {
  it("moves the entry to retired.json and keeps its files; the last one stays", () => {
    const dir = home();
    const { admin, changes } = registry(dir);
    admin.create({ title: "Vega" });
    admin.retire("vega");
    expect(raw(dir).agents).toEqual([NOVA, ASTRA]);
    expect(changes.at(-1)?.map((agent) => agent.id)).toEqual(["nova", "astra"]);
    expect(JSON.parse(readFileSync(join(dir, RETIRED_FILE), "utf8"))).toEqual({ retired: [expect.objectContaining({ id: "vega", retiredAt: "2026-11-04T00:00:00.000Z" })] });
    expect(existsSync(join(dir, primeFile("vega")))).toBe(true);
    admin.retire("astra");
    expect(() => admin.retire("nova")).toThrow(/only assistant/);
    expect(() => admin.retire("nobody")).toThrow(/no assistant nobody/);
  });
});

describe("AssistantRegistry reload and watch", () => {
  it("hands a changed, valid file to onChange once, and keeps the last good list for a broken one", () => {
    const dir = home();
    const { admin, changes, logs } = registry(dir);
    admin.reload();
    expect(changes).toHaveLength(1);
    admin.reload();
    expect(changes).toHaveLength(1);
    writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ agents: [ASTRA, ASTRA] }));
    admin.reload();
    expect(changes).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/keeping the last good list: .*duplicate id astra/);
    writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ agents: [ASTRA] }));
    admin.reload();
    expect(changes.at(-1)).toEqual([{ id: "astra", title: "Astra", scope: "eCard Systems work", avatar: "astra-2" }]);
  });

  it("rereads agents.json once a burst of changes to it settles, ignoring other files", () => {
    vi.useFakeTimers();
    try {
      const dir = home();
      const watched: { changed: (name: string | null) => void; closed: boolean } = { changed: () => undefined, closed: false };
      const changes: (readonly AssistantAgentConfig[])[] = [];
      const admin = new AssistantRegistry({
        agentHome: dir,
        userName: () => "Jane",
        cli: "relay-linux",
        log: () => undefined,
        watchDir: (path, callback) => {
          expect(path).toBe(join(dir, ".omp", "assistant"));
          watched.changed = callback;
          return { close: () => (watched.closed = true) };
        },
      });
      admin.onChange = (agents) => changes.push(agents);
      const stop = admin.watch();
      writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ agents: [NOVA, ASTRA, { id: "vega", title: "Vega" }] }));
      watched.changed("thread.template.md");
      vi.advanceTimersByTime(WATCH_SETTLE_MS);
      expect(changes).toEqual([]);
      watched.changed("agents.json");
      vi.advanceTimersByTime(WATCH_SETTLE_MS - 1);
      watched.changed("agents.json");
      vi.advanceTimersByTime(WATCH_SETTLE_MS);
      expect(changes.map((agents) => agents.map((agent) => agent.id))).toEqual([["nova", "astra", "vega"]]);
      stop();
      expect(watched.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("assistant registry routes", () => {
  it("are loopback only and answer a bad change with a 400", async () => {
    const dir = home();
    const { admin } = registry(dir);
    const route = (path: string, init: RequestInit = {}, remote = "127.0.0.1") => handleAssistantAdmin({ registry: admin, assistant: null }, new Request(`http://127.0.0.1${path}`, init), remote, path);
    expect((await route("/assistant/registry", {}, "100.64.0.9")).status).toBe(403);
    expect(await (await route("/assistant/registry")).json()).toEqual({ agents: [NOVA, ASTRA] });
    const bad = await route("/assistant/registry/nova", { method: "PATCH", body: JSON.stringify({ liveVoice: "robot" }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/liveVoice must be one of/);
    const good = await route("/assistant/registry/nova", { method: "PATCH", body: JSON.stringify({ scope: "Home" }) });
    expect(await good.json()).toEqual({ changes: [{ field: "scope", from: "Personal", to: "Home" }] });
    expect((await route("/assistant/registry", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
