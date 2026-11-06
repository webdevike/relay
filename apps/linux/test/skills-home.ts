// A throwaway home and Eva checkout for the skills tests: skill folders in every source, an
// assistant registry, omp profile configs and a fake omp. Never touches the real ~/.omp or ~/Eva.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OmpRun } from "../src/skills/catalog";

export interface SkillsHome {
  readonly home: string;
  readonly evaRoot: string;
  /** Writes `text` at `path` under the home, creating folders. */
  write(path: string, text: string): string;
  /** Every `omp config set` call the catalog made. */
  readonly calls: string[][];
  readonly run: OmpRun;
  /** The fake `omp skill list`: what omp finds (`listed`), minus what the asked profile's own config switches off. */
  readonly list: OmpRun;
  /** Every `omp skill list` call: its args and whether it ran without config. */
  readonly listCalls: { args: string[]; bare: boolean }[];
  /** What omp finds in the Eva checkout: name, folder under the home, omp's source id, and the profiles that find it (all when absent; null: default). */
  listed: { name: string; dir: string; source: string; profiles?: (string | null)[] }[];
  /** What the fake `omp config set` answers next. */
  answer: { code: number | null; stdout: string; stderr: string };
  cleanup(): void;
}

export const skillText = (name: string, description: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`;

/**
 * omp lists alpha and beta (`enabled: false`) from Eva's .omp/skills, Eva's .agents copy of alpha as
 * `agents/alpha`, gamma from ~/.agents, zeta from Eva's .claude and delta from a Claude plugin; the
 * default profile also lists omega from its own ~/.omp/agent/skills.
 * Assistants: nova and polaris on `personal`, astra on `work`, dflt on omp's default profile.
 * Profiles: personal disables alpha, work disables gamma.
 */
export function skillsHome(): SkillsHome {
  const home = mkdtempSync(join(tmpdir(), "relay-skills-"));
  const evaRoot = join(home, "Eva");
  const write = (path: string, text: string): string => {
    const full = join(home, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    return full;
  };
  write("Eva/.omp/skills/alpha/SKILL.md", skillText("alpha", "Alpha skill"));
  write("Eva/.omp/skills/alpha/refs/guide.md", "guide\n");
  write("Eva/.omp/skills/alpha/.hidden", "x");
  write("Eva/.omp/skills/alpha/node_modules/dep/index.js", "x");
  utimesSync(join(home, "Eva/.omp/skills/alpha/refs/guide.md"), 1_700_000_000, 1_700_000_000);
  write("Eva/.omp/skills/beta/SKILL.md", skillText("beta", "Beta skill", "enabled: false\n"));
  write("Eva/.agents/skills/alpha/SKILL.md", skillText("alpha", "Another alpha"));
  write("Eva/.claude/skills/zeta/SKILL.md", skillText("zeta", "Zeta skill"));
  write(".omp/agent/skills/omega/SKILL.md", skillText("omega", "Omega skill"));
  write(".agents/skills/gamma/SKILL.md", skillText("gamma", "Gamma skill"));
  // A link into .agents, as ~/.claude/skills often is (the room saves through it).
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  symlinkSync("../../.agents/skills/gamma", join(home, ".claude/skills/gamma"));
  write(".omp/plugins/node_modules/pkg-x/skills/delta/SKILL.md", skillText("delta", "Delta skill"));
  write(
    "Eva/.omp/assistant/agents.json",
    JSON.stringify({
      agents: [
        { id: "nova", title: "Nova", profile: "personal", avatar: { style: "micah", seed: "n", colors: { accent: "#f76707" } } },
        { id: "polaris", title: "Polaris", profile: "personal" },
        { id: "astra", title: "Astra", profile: "work", avatar: { style: "micah", seed: "a", colors: { accent: "#1c7ed6" } } },
        { id: "dflt", title: "Default" },
      ],
    }),
  );
  write(".omp/profiles/personal/agent/config.yml", "# personal\ndisabledExtensions:\n  - skill:alpha\n");
  write(".omp/profiles/work/agent/config.yml", "disabledExtensions: [skill:gamma]\n");
  const calls: string[][] = [];
  const listCalls: { args: string[]; bare: boolean }[] = [];
  /** The `skill:` names a config.yml switches off (the fake reads only that pattern). */
  const off = (path: string): string[] => {
    try {
      return [...readFileSync(join(home, path), "utf8").matchAll(/skill:([a-z0-9._:/-]+)/g)].map((match) => match[1] ?? "");
    } catch {
      return [];
    }
  };
  const state: SkillsHome = {
    home,
    evaRoot,
    write,
    calls,
    listCalls,
    listed: [
      { name: "alpha", dir: "Eva/.omp/skills/alpha", source: "native:project" },
      { name: "beta", dir: "Eva/.omp/skills/beta", source: "native:project" },
      { name: "agents/alpha", dir: "Eva/.agents/skills/alpha", source: "agents:project" },
      { name: "gamma", dir: ".agents/skills/gamma", source: "agents:user" },
      { name: "zeta", dir: "Eva/.claude/skills/zeta", source: "claude:project" },
      { name: "delta", dir: ".omp/plugins/node_modules/pkg-x/skills/delta", source: "claude-plugins:user" },
      { name: "omega", dir: ".omp/agent/skills/omega", source: "native:user", profiles: [null] },
    ],
    answer: { code: 0, stdout: "", stderr: "" },
    run: (args) => {
      calls.push([...args]);
      return Promise.resolve(state.answer);
    },
    list: (args, env = {}) => {
      const bare = env["PI_CODING_AGENT_DIR"] !== undefined;
      listCalls.push({ args: [...args], bare });
      const profile = args[0] === "--profile" ? args[1] : undefined;
      const disabled = bare ? [] : off(profile === undefined ? ".omp/agent/config.yml" : `.omp/profiles/${profile}/agent/config.yml`);
      const skills = state.listed
        .filter((skill) => !disabled.includes(skill.name) && (bare || skill.profiles === undefined || skill.profiles.includes(profile ?? null)))
        .map((skill) => ({ name: skill.name, description: `${skill.name} from omp`, filePath: join(home, skill.dir, "SKILL.md"), baseDir: join(home, skill.dir), source: skill.source, hide: false }));
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ skills, warnings: [] }), stderr: "" });
    },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
  return state;
}
