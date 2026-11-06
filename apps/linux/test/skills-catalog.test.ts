import { utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DISCOVERY_TTL_MS, SkillCatalog, sourceLabel } from "../src/skills/catalog";
import { SkillError } from "../src/skills/types";
import { type SkillsHome, skillsHome } from "./skills-home";

const homes: SkillsHome[] = [];

async function setup(now: () => number = Date.now): Promise<{ home: SkillsHome; catalog: SkillCatalog }> {
  const home = skillsHome();
  homes.push(home);
  const catalog = new SkillCatalog({ home: home.home, evaRoot: home.evaRoot, run: home.run, list: home.list, now });
  await catalog.refresh();
  return { home, catalog };
}

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

const usedBy = (catalog: SkillCatalog): Record<string, string[]> => Object.fromEntries(catalog.entries().map((entry) => [entry.row.name, entry.row.usedBy]));

describe("SkillCatalog", () => {
  it("lists what omp lists for each profile, with omp's names and sources", async () => {
    const { home, catalog } = await setup();
    const rows = Object.fromEntries(catalog.entries().map((entry) => [entry.row.name, entry.row]));
    expect(Object.keys(rows)).toEqual(["agents/alpha", "alpha", "beta", "delta", "gamma", "omega", "zeta"]);
    expect(rows["alpha"]?.source).toMatchObject({ key: "native:project", label: "Project", dir: "~/Eva/.omp/skills/alpha" });
    expect(rows["alpha"]?.description).toBe("alpha from omp");
    expect(rows["agents/alpha"]?.source).toMatchObject({ key: "agents:project", label: "Agents project", dir: "~/Eva/.agents/skills/alpha" });
    expect(rows["gamma"]?.source).toMatchObject({ key: "agents:user", label: "Agents" });
    expect(rows["zeta"]?.source).toMatchObject({ key: "claude:project", label: "Claude project" });
    expect(rows["delta"]?.source).toMatchObject({ key: "claude-plugins:user", label: "Claude plugin" });
    // Only the default profile finds it, so only the assistant on that profile uses it.
    expect(rows["omega"]).toMatchObject({ source: { key: "native:user", label: "User", dir: "~/.omp/agent/skills/omega" }, usedBy: ["dflt"] });
    expect(rows["beta"]?.disabled).toBe(true);
    // One listing per profile (default, personal, work) and one without any config.
    expect(home.listCalls.map((call) => `${call.args.join(" ")}${call.bare ? " (bare)" : ""}`).sort()).toEqual([
      "--profile personal skill list --json",
      "--profile work skill list --json",
      "skill list --json",
      "skill list --json (bare)",
    ]);
    expect(sourceLabel("plugin:unreal")).toBe("Plugin");
  });

  it("says which tool loads a skill and what package it came from", async () => {
    const { home, catalog } = await setup();
    home.write(".agents/.skill-lock.json", JSON.stringify({ version: 3, skills: { gamma: { source: "acme/skills", sourceType: "github" } } }));
    home.write("Eva/skills-lock.json", JSON.stringify({ version: 1, skills: { zeta: { source: "zed/zeta-skills" } } }));
    await catalog.refresh(true);
    const rows = Object.fromEntries(catalog.entries().map((entry) => [entry.row.name, entry.row]));
    // omp's own folder; Claude's own folder; omp's folder linked into ~/.claude/skills; a Claude plugin.
    expect(rows["alpha"]).toMatchObject({ origin: "omp", package: null });
    expect(rows["zeta"]).toMatchObject({ origin: "claude", package: "zed/zeta-skills" });
    expect(rows["gamma"]).toMatchObject({ origin: "both", package: "acme/skills" });
    expect(rows["omega"]?.origin).toBe("omp");
    // A skill in a plugin or repo's skills folder is that folder's; a lock overrides it.
    expect(rows["delta"]).toMatchObject({ origin: "claude", package: "pkg-x" });
  });

  it("works out who uses a skill from the profiles' disabledExtensions, keeping one every profile switched off", async () => {
    const { home, catalog } = await setup();
    expect(usedBy(catalog)["alpha"]).toEqual(["astra", "dflt"]);
    expect(usedBy(catalog)["gamma"]).toEqual(["nova", "polaris", "dflt"]);
    expect(usedBy(catalog)["delta"]).toEqual(["nova", "polaris", "astra", "dflt"]);
    // `enabled: false` turns it off for everyone.
    expect(usedBy(catalog)["beta"]).toEqual([]);
    // Off in every profile: omp lists it nowhere, and the row stays so it can be switched on.
    home.write(".omp/profiles/personal/agent/config.yml", "disabledExtensions: [skill:zeta]\n");
    home.write(".omp/profiles/work/agent/config.yml", "disabledExtensions: [skill:zeta]\n");
    home.write(".omp/agent/config.yml", "disabledExtensions: [skill:zeta]\n");
    await catalog.refresh(true);
    expect(catalog.entry("zeta")?.row).toMatchObject({ usedBy: [], source: { key: "claude:project" } });
    expect(catalog.assistants()).toEqual([
      { id: "nova", title: "Nova", profile: "personal", color: "#f76707" },
      { id: "polaris", title: "Polaris", profile: "personal", color: expect.stringMatching(/^#[0-9a-f]{6}$/) as unknown },
      { id: "astra", title: "Astra", profile: "work", color: "#1c7ed6" },
      { id: "dflt", title: "Default", profile: null, color: expect.stringMatching(/^#[0-9a-f]{6}$/) as unknown },
    ]);
  });

  it("lets the ~/.omp/agent/config.yml overlay's list win over every profile's", async () => {
    const { home, catalog } = await setup();
    home.write(".omp/agent/config.yml", "disabledExtensions:\n  - skill:delta\n");
    await catalog.refresh(true);
    expect(usedBy(catalog)["alpha"]).toEqual(["nova", "polaris", "astra", "dflt"]);
    expect(usedBy(catalog)["delta"]).toEqual([]);
    expect(catalog.effectiveDisabled("work")).toEqual(["skill:delta"]);
  });

  it("asks omp again only once its answer is stale", async () => {
    let now = 1_000_000;
    const { home, catalog } = await setup(() => now);
    await catalog.refresh();
    expect(home.listCalls).toHaveLength(4);
    now += DISCOVERY_TTL_MS;
    await catalog.refresh();
    expect(home.listCalls).toHaveLength(8);
  });

  it("lists a skill's files and dates it by the newest mtime, skipping dotfiles and node_modules", async () => {
    const { home, catalog } = await setup();
    const dir = join(home.evaRoot, ".omp", "skills", "alpha");
    utimesSync(join(dir, "SKILL.md"), 1_700_000_100, 1_700_000_100);
    utimesSync(join(dir, "refs", "guide.md"), 1_700_000_200, 1_700_000_200);
    utimesSync(join(dir, "refs"), 1_700_000_050, 1_700_000_050);
    const entry = catalog.entry("alpha");
    expect(entry?.row.updatedAt).toBe(1_700_000_200_000);
    expect(entry === null ? [] : catalog.files(entry)).toEqual([
      { path: "SKILL.md", size: expect.any(Number) as unknown },
      { path: "refs/guide.md", size: 6 },
    ]);
  });

  it("switches access per profile through omp config set, then asks omp again", async () => {
    const { home, catalog } = await setup();
    await catalog.setAccess("alpha", { nova: true });
    await catalog.setAccess("alpha", { astra: false });
    await catalog.setAccess("gamma", { dflt: false });
    expect(home.calls).toEqual([
      ["--profile", "personal", "config", "set", "disabledExtensions", "[]"],
      ["--profile", "work", "config", "set", "disabledExtensions", '["skill:gamma","skill:alpha"]'],
      ["config", "set", "disabledExtensions", '["skill:gamma"]'],
    ]);
    expect(home.listCalls).toHaveLength(16);
    // Already as asked: no call.
    await catalog.setAccess("gamma", { nova: true });
    expect(home.calls).toHaveLength(3);
  });

  it("refuses split profiles, unknown assistants, an overlay list and a failing omp", async () => {
    const { home, catalog } = await setup();
    await expect(catalog.setAccess("alpha", { nova: true, polaris: false })).rejects.toMatchObject({ status: 400 });
    await expect(catalog.setAccess("alpha", { ghost: true })).rejects.toMatchObject({ status: 400 });
    await expect(catalog.setAccess("nope", { nova: true })).rejects.toMatchObject({ status: 404 });
    home.answer = { code: 1, stdout: "", stderr: "boom" };
    await expect(catalog.setAccess("alpha", { nova: true })).rejects.toThrow(/boom/);
    home.write(".omp/agent/config.yml", "disabledExtensions: []\n");
    const refused = catalog.setAccess("alpha", { astra: false });
    await expect(refused).rejects.toBeInstanceOf(SkillError);
    await expect(refused).rejects.toMatchObject({ status: 409 });
  });

  it("keeps its last answer when omp fails", async () => {
    const home = skillsHome();
    homes.push(home);
    let broken = false;
    const catalog = new SkillCatalog({
      home: home.home,
      evaRoot: home.evaRoot,
      run: home.run,
      list: (args, env) => (broken ? Promise.resolve({ code: 1, stdout: "", stderr: "no omp" }) : home.list(args, env)),
    });
    await catalog.refresh();
    broken = true;
    await catalog.refresh(true);
    expect(catalog.entries()).toHaveLength(7);
  });
});
