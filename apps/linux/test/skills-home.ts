// A throwaway home and Eva checkout for the skills tests: skill folders in every source, an
// assistant registry and omp profile configs. Never touches the real ~/.omp or ~/Eva.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OmpRun } from "../src/skills/catalog";

export interface SkillsHome {
  readonly home: string;
  readonly evaRoot: string;
  /** Writes `text` at `path` under the home, creating folders. */
  write(path: string, text: string): string;
  /** Every `omp` call the catalog made. */
  readonly calls: string[][];
  readonly run: OmpRun;
  /** What the fake omp answers next. */
  answer: { code: number | null; stdout: string; stderr: string };
  cleanup(): void;
}

export const skillText = (name: string, description: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`;

/**
 * Skills: alpha in eva (also in omp, differing), beta in eva with `enabled: false`, gamma in
 * .agents with .claude symlinking to it, delta from plugin `pkg-x`, eps from scoped `@s/p`.
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
  write("Eva/.omp/skills/no-skill/README.md", "not a skill\n");
  write("Eva/.omp/skills/LIBRARY.md", "index\n");
  write(".omp/agent/skills/alpha/SKILL.md", skillText("alpha", "Older alpha"));
  write(".agents/skills/gamma/SKILL.md", skillText("gamma", "Gamma skill"));
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  symlinkSync("../../.agents/skills/gamma", join(home, ".claude/skills/gamma"));
  write(".omp/plugins/node_modules/pkg-x/skills/delta/SKILL.md", skillText("delta", "Delta skill"));
  write(".omp/plugins/node_modules/@s/p/skills/eps/SKILL.md", skillText("eps", "Eps skill"));
  write(".omp/plugins/node_modules/no-skills/package.json", "{}");
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
  const state: SkillsHome = {
    home,
    evaRoot,
    write,
    calls,
    answer: { code: 0, stdout: "", stderr: "" },
    run: (args) => {
      calls.push([...args]);
      return Promise.resolve(state.answer);
    },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
  return state;
}
