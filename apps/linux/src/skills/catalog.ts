// Every skill omp can load on this host, and who loads it. Copies come from Eva's skills
// (`<evaRoot>/.omp/skills`), omp's own (`~/.omp/agent/skills`), omp plugins
// (`~/.omp/plugins/node_modules/<pkg>/skills`), `~/.claude/skills` and `~/.agents/skills`; one row
// per name, the copy omp loads first (eva, omp, plugin, claude, agents) as its source and the rest
// as `also`. Access is omp's own per-profile switch: `disabledExtensions: [skill:<name>]` in a
// profile's config.yml. Profiled sessions also load `~/.omp/agent/config.yml` as a `--config`
// overlay (agents/herdr.ts), and an overlay's arrays replace the profile's, so a list set there wins.
// Read on every call: the folders are small and change under the host's feet.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { loadRegistry } from "../assistant/registry";
import { frontmatterData, splitFrontmatter } from "./doc";
import { type Assistant, SKILL_NAME, SkillError, type SkillRow, type SkillSource, type SourceKey } from "./types";

/** omp's load order: the first copy of a name wins. */
const PRECEDENCE: readonly SourceKey[] = ["eva", "omp", "plugin", "claude", "agents"];
/** Files listed in a skill's detail. */
export const MAX_FILES = 200;
/** Files a row looks at for its newest mtime. */
const MAX_SCAN = 2000;
/** Colors for assistants without a designed portrait accent. */
const PALETTE = ["#1c7ed6", "#f76707", "#2f9e44", "#ae3ec9", "#e8590c", "#0ca678", "#d6336c", "#5f3dc4"];

/** Runs `omp <args>` and reports how it went. */
export type OmpRun = (args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface CatalogDeps {
  /** The home dir (`~`). */
  readonly home: string;
  /** The Eva checkout (the host's agent home); null leaves out Eva's skills and the assistants. */
  readonly evaRoot: string | null;
  readonly run: OmpRun;
}

/** One copy of a skill on disk. */
export interface SkillCopy {
  readonly name: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly source: SkillSource;
  /** The folder, symlinks resolved. */
  readonly realDir: string;
}

/** A row plus the copy behind it. */
export interface CatalogEntry {
  readonly row: Omit<SkillRow, "lastUsedAt">;
  readonly primary: SkillCopy;
}

/** A stable color for `seed` from the palette. */
export function paletteColor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? "#1c7ed6";
}

/** The `disabledExtensions` a config.yml sets; undefined when it sets none (or cannot be read). */
function configList(path: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const list = frontmatterData(text)["disabledExtensions"];
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : undefined;
}

/** Files under `dir` (skipping dotfiles and node_modules), in walk order, and the newest mtime seen. */
function walk(dir: string, cap: number): { files: { path: string; size: number }[]; newest: number; truncated: boolean } {
  const files: { path: string; size: number }[] = [];
  let newest = 0;
  let truncated = false;
  const visit = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      if (files.length >= cap) {
        truncated = true;
        return;
      }
      const path = join(current, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      newest = Math.max(newest, stats.mtimeMs);
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) files.push({ path: relative(dir, path).split(sep).join("/"), size: stats.size });
    }
  };
  visit(dir);
  return { files, newest, truncated };
}

export class SkillCatalog {
  constructor(private readonly deps: CatalogDeps) {}

  /** The assistants of Eva's registry with their profile and color; empty without one. */
  assistants(): Assistant[] {
    if (this.deps.evaRoot === null) return [];
    try {
      return loadRegistry(this.deps.evaRoot).map((agent) => ({
        id: agent.id,
        title: agent.title,
        profile: agent.profile ?? null,
        color: agent.portrait?.colors?.accent ?? paletteColor(agent.id),
      }));
    } catch {
      return [];
    }
  }

  /** Every copy of every skill, in no particular order. */
  copies(): SkillCopy[] {
    const { home, evaRoot } = this.deps;
    const roots: { key: SourceKey; label: string; dir: string }[] = [];
    if (evaRoot !== null) roots.push({ key: "eva", label: "Eva", dir: join(evaRoot, ".omp", "skills") });
    roots.push({ key: "omp", label: "omp", dir: join(home, ".omp", "agent", "skills") });
    const plugins = join(home, ".omp", "plugins", "node_modules");
    for (const pkg of this.packages(plugins)) roots.push({ key: "plugin", label: pkg, dir: join(plugins, pkg, "skills") });
    roots.push({ key: "claude", label: ".claude", dir: join(home, ".claude", "skills") });
    roots.push({ key: "agents", label: ".agents", dir: join(home, ".agents", "skills") });
    const out: SkillCopy[] = [];
    for (const root of roots) {
      let entries: string[];
      try {
        entries = readdirSync(root.dir).sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const copy = this.read(root, entry);
        if (copy !== null) out.push(copy);
      }
    }
    return out;
  }

  /** One row per skill name, sorted by name. */
  entries(): CatalogEntry[] {
    const assistants = this.assistants();
    const groups = new Map<string, SkillCopy[]>();
    for (const copy of this.copies()) {
      const group = groups.get(copy.name);
      if (group === undefined) groups.set(copy.name, [copy]);
      else group.push(copy);
    }
    const disabled = this.disabledByProfile(assistants);
    const out: CatalogEntry[] = [];
    for (const [name, group] of groups) {
      group.sort((a, b) => PRECEDENCE.indexOf(a.source.key) - PRECEDENCE.indexOf(b.source.key));
      const [primary, ...rest] = group;
      if (primary === undefined) continue;
      out.push({
        primary,
        row: {
          name,
          description: primary.description,
          source: primary.source,
          also: rest.map((copy) => copy.source),
          updatedAt: Math.round(walk(primary.realDir, MAX_SCAN).newest),
          usedBy: primary.disabled ? [] : assistants.filter((assistant) => !(disabled.get(assistant.profile) ?? []).includes(`skill:${name}`)).map((assistant) => assistant.id),
          disabled: primary.disabled,
        },
      });
    }
    return out.sort((a, b) => a.row.name.localeCompare(b.row.name));
  }

  /** The entry for `name`, or null. */
  entry(name: string): CatalogEntry | null {
    return this.entries().find((entry) => entry.row.name === name) ?? null;
  }

  /** Files of a skill folder, relative paths, at most `MAX_FILES`. */
  files(entry: CatalogEntry): { path: string; size: number }[] {
    return walk(entry.primary.realDir, MAX_FILES).files;
  }

  /**
   * The `disabledExtensions` sessions of `profile` (null: omp's default profile) run with: the
   * overlay's when it sets the key, else the profile's own.
   */
  effectiveDisabled(profile: string | null): string[] {
    const overlay = configList(this.overlayPath());
    if (profile === null || overlay !== undefined) return overlay ?? [];
    return configList(this.profilePath(profile)) ?? [];
  }

  /**
   * Turns `name` on or off for assistants (`enabled` by assistant id) through their profiles'
   * `disabledExtensions`, written with `omp config set`. Assistants on one profile move together.
   */
  async setAccess(name: string, enabled: Readonly<Record<string, boolean>>): Promise<void> {
    if (this.entry(name) === null) throw new SkillError(404, `no skill ${name}`);
    const assistants = this.assistants();
    const wanted = new Map<string | null, boolean>();
    const who = new Map<string | null, string>();
    for (const [id, on] of Object.entries(enabled)) {
      const assistant = assistants.find((candidate) => candidate.id === id);
      if (assistant === undefined) throw new SkillError(400, `no assistant ${id}`);
      const earlier = wanted.get(assistant.profile);
      if (earlier !== undefined && earlier !== on)
        throw new SkillError(400, `${who.get(assistant.profile) ?? ""} and ${id} share profile ${assistant.profile ?? "default"}: their skills switch together`);
      wanted.set(assistant.profile, on);
      who.set(assistant.profile, id);
    }
    const overlay = configList(this.overlayPath());
    const extension = `skill:${name}`;
    for (const [profile, on] of wanted) {
      if (profile !== null && overlay !== undefined)
        throw new SkillError(409, `${this.overlayPath()} sets disabledExtensions for every profile; take it out there to switch skills per assistant`);
      const current = this.effectiveDisabled(profile);
      const next = on ? current.filter((item) => item !== extension) : current.includes(extension) ? current : [...current, extension];
      if (next.length === current.length && next.every((item, index) => item === current[index])) continue;
      const args = [...(profile === null ? [] : ["--profile", profile]), "config", "set", "disabledExtensions", JSON.stringify(next)];
      const result = await this.deps.run(args);
      if (result.code !== 0) throw new SkillError(502, `omp ${args.join(" ")} failed: ${(result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`).slice(0, 400)}`);
    }
  }

  private overlayPath(): string {
    return join(this.deps.home, ".omp", "agent", "config.yml");
  }

  private profilePath(profile: string): string {
    return join(this.deps.home, ".omp", "profiles", profile, "agent", "config.yml");
  }

  /** Each assistant profile's effective list, read once per listing. */
  private disabledByProfile(assistants: readonly Assistant[]): Map<string | null, string[]> {
    const out = new Map<string | null, string[]>();
    for (const { profile } of assistants) if (!out.has(profile)) out.set(profile, this.effectiveDisabled(profile));
    return out;
  }

  /** Package names under a node_modules dir (scoped ones as `@scope/pkg`) that ship a `skills` folder. */
  private packages(dir: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (entry.startsWith("@")) {
        let scoped: string[] = [];
        try {
          scoped = readdirSync(join(dir, entry)).sort();
        } catch {
          // not a dir
        }
        for (const pkg of scoped) if (existsSync(join(dir, entry, pkg, "skills"))) out.push(`${entry}/${pkg}`);
      } else if (existsSync(join(dir, entry, "skills"))) out.push(entry);
    }
    return out;
  }

  /** The copy in `root`'s folder `entry`, or null when it holds no readable SKILL.md with a usable name. */
  private read(root: { key: SourceKey; label: string; dir: string }, entry: string): SkillCopy | null {
    const dir = join(root.dir, entry);
    const file = join(dir, "SKILL.md");
    let text: string;
    let realDir: string;
    try {
      if (!statSync(file).isFile()) return null;
      text = readFileSync(file, "utf8");
      realDir = realpathSync(dir);
    } catch {
      return null;
    }
    const data = frontmatterData(splitFrontmatter(text).yaml);
    const declared = typeof data["name"] === "string" ? data["name"].trim() : "";
    const name = SKILL_NAME.test(declared) ? declared : SKILL_NAME.test(basename(dir)) ? basename(dir) : null;
    if (name === null) return null;
    const home = this.deps.home;
    return {
      name,
      description: typeof data["description"] === "string" ? data["description"] : "",
      disabled: data["enabled"] === false,
      realDir,
      source: { key: root.key, label: root.label, dir: dir.startsWith(`${home}${sep}`) ? `~${dir.slice(home.length)}` : dir, file },
    };
  }
}

/** The real `OmpRun`: `omp` (the resolved binary) from the home dir, killed after 30 s. */
export function ompRunner(omp: string, cwd: string): OmpRun {
  return (args) => {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
    execFile(omp, [...args], { cwd, timeout: 30_000, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, stdout, stderr: error !== null && stderr === "" ? error.message : stderr });
    });
    return promise;
  };
}
