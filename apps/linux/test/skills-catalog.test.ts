import { utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillCatalog } from "../src/skills/catalog";
import { SkillError } from "../src/skills/types";
import { type SkillsHome, skillsHome } from "./skills-home";

const homes: SkillsHome[] = [];

function setup(): { home: SkillsHome; catalog: SkillCatalog } {
  const home = skillsHome();
  homes.push(home);
  return { home, catalog: new SkillCatalog({ home: home.home, evaRoot: home.evaRoot, run: home.run }) };
}

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe("SkillCatalog", () => {
  it("groups copies by name with omp's precedence and lists the rest as also", () => {
    const { catalog } = setup();
    const rows = Object.fromEntries(catalog.entries().map((entry) => [entry.row.name, entry.row]));
    expect(Object.keys(rows)).toEqual(["alpha", "beta", "delta", "eps", "gamma"]);
    expect(rows["alpha"]?.source).toMatchObject({ key: "eva", label: "Eva", dir: "~/Eva/.omp/skills/alpha" });
    expect(rows["alpha"]?.description).toBe("Alpha skill");
    expect(rows["alpha"]?.also.map((copy) => copy.key)).toEqual(["omp"]);
    // .claude/skills/gamma is a symlink into .agents: one row, .claude first, .agents as also.
    expect(rows["gamma"]?.source).toMatchObject({ key: "claude", label: ".claude", dir: "~/.claude/skills/gamma" });
    expect(rows["gamma"]?.also).toEqual([{ key: "agents", label: ".agents", dir: "~/.agents/skills/gamma", file: expect.stringContaining(".agents/skills/gamma/SKILL.md") as unknown }]);
    expect(rows["delta"]?.source).toMatchObject({ key: "plugin", label: "pkg-x" });
    expect(rows["eps"]?.source).toMatchObject({ key: "plugin", label: "@s/p" });
    expect(rows["beta"]?.disabled).toBe(true);
  });

  it("works out who uses a skill from the profiles' disabledExtensions", () => {
    const { catalog } = setup();
    const usedBy = Object.fromEntries(catalog.entries().map((entry) => [entry.row.name, entry.row.usedBy]));
    expect(usedBy["alpha"]).toEqual(["astra", "dflt"]);
    expect(usedBy["gamma"]).toEqual(["nova", "polaris", "dflt"]);
    expect(usedBy["delta"]).toEqual(["nova", "polaris", "astra", "dflt"]);
    // `enabled: false` turns it off for everyone.
    expect(usedBy["beta"]).toEqual([]);
    expect(catalog.assistants()).toEqual([
      { id: "nova", title: "Nova", profile: "personal", color: "#f76707" },
      { id: "polaris", title: "Polaris", profile: "personal", color: expect.stringMatching(/^#[0-9a-f]{6}$/) as unknown },
      { id: "astra", title: "Astra", profile: "work", color: "#1c7ed6" },
      { id: "dflt", title: "Default", profile: null, color: expect.stringMatching(/^#[0-9a-f]{6}$/) as unknown },
    ]);
  });

  it("lets the ~/.omp/agent/config.yml overlay's list win over every profile's", () => {
    const { home, catalog } = setup();
    home.write(".omp/agent/config.yml", "disabledExtensions:\n  - skill:delta\n");
    const usedBy = Object.fromEntries(catalog.entries().map((entry) => [entry.row.name, entry.row.usedBy]));
    expect(usedBy["alpha"]).toEqual(["nova", "polaris", "astra", "dflt"]);
    expect(usedBy["delta"]).toEqual([]);
    expect(catalog.effectiveDisabled("work")).toEqual(["skill:delta"]);
  });

  it("lists a skill's files and dates it by the newest mtime, skipping dotfiles and node_modules", () => {
    const { home, catalog } = setup();
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

  it("switches access per profile through omp config set", async () => {
    const { home, catalog } = setup();
    await catalog.setAccess("alpha", { nova: true });
    await catalog.setAccess("alpha", { astra: false });
    await catalog.setAccess("gamma", { dflt: false });
    expect(home.calls).toEqual([
      ["--profile", "personal", "config", "set", "disabledExtensions", "[]"],
      ["--profile", "work", "config", "set", "disabledExtensions", '["skill:gamma","skill:alpha"]'],
      ["config", "set", "disabledExtensions", '["skill:gamma"]'],
    ]);
    // Already as asked: no call.
    await catalog.setAccess("gamma", { nova: true });
    expect(home.calls).toHaveLength(3);
  });

  it("refuses split profiles, unknown assistants, an overlay list and a failing omp", async () => {
    const { home, catalog } = setup();
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
});
