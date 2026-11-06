// Every skill omp loads on this host, and who loads it, as omp itself reports it: `omp [--profile
// <p>] skill list --json` run in the Eva checkout for omp's default profile and each assistant's
// profile. One row per name; its source is omp's (`native:project`, `agents:user`, `claude:project`,
// a plugin's, ...). A skill a profile switched off (`disabledExtensions: [skill:<name>]`) is missing
// from that profile's list; it comes from a listing with no config at all, so it can be switched on
// again. omp runs without the host's own profile variables (`OMP_PROFILE`, ...), so it lists for the
// profile asked.
// Access is omp's own per-profile switch, `disabledExtensions` in a profile's config.yml. Profiled
// sessions also load `~/.omp/agent/config.yml` as a `--config` overlay (agents/herdr.ts), and an
// overlay's arrays replace the profile's, so a list set there wins. omp is asked again at most every
// `DISCOVERY_TTL_MS` (and at once after a switch); the skill folders are read on every call.

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { loadRegistry } from "../assistant/registry";
import { frontmatterData, splitFrontmatter } from "./doc";
import { type Assistant, SKILL_NAME, SkillError, type SkillRow, type SkillSource } from "./types";

/** Files listed in a skill's detail. */
export const MAX_FILES = 200;
/** How long omp's answer stands before it is asked again. */
export const DISCOVERY_TTL_MS = 30_000;
/** Files a row looks at for its newest mtime. */
const MAX_SCAN = 2000;
/** Colors for assistants without a designed portrait accent. */
const PALETTE = ["#1c7ed6", "#f76707", "#2f9e44", "#ae3ec9", "#e8590c", "#0ca678", "#d6336c", "#5f3dc4"];
/** Labels for omp's sources; any other is its provider's name. */
const SOURCE_LABELS: Record<string, string> = {
  "native:project": "Project",
  "native:user": "User",
  "agents:project": "Agents project",
  "agents:user": "Agents",
  "claude:project": "Claude project",
  "claude:user": "Claude",
  "claude-plugins:user": "Claude plugin",
  "codex:project": "Codex project",
  "codex:user": "Codex",
};
/** omp's environment, minus what picks a profile or agent dir for it. */
const PROFILE_ENV = ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR"];

/** Runs `omp <args>` (with `env` added to the host's) and reports how it went. */
export type OmpRun = (args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface CatalogDeps {
  /** The home dir (`~`). */
  readonly home: string;
  /** The Eva checkout (the host's agent home): omp lists skills from here. Null leaves out the assistants. */
  readonly evaRoot: string | null;
  /** `omp config set` (any cwd). */
  readonly run: OmpRun;
  /** `omp skill list`, in the Eva checkout. */
  readonly list: OmpRun;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
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
  readonly row: Omit<SkillRow, "lastUsedAt" | "uses">;
  readonly primary: SkillCopy;
}

const OmpSkill = z.object({ name: z.string(), description: z.string().catch(""), filePath: z.string(), baseDir: z.string(), source: z.string() });
type OmpSkill = z.infer<typeof OmpSkill>;
const OmpSkillList = z.object({ skills: z.array(OmpSkill) });

/** What omp lists per profile (null: its default profile), and with no config at all. */
interface Discovery {
  readonly at: number;
  readonly byProfile: ReadonlyMap<string | null, readonly SkillCopy[]>;
  readonly bare: readonly SkillCopy[];
}

/** A stable color for `seed` from the palette. */
export function paletteColor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? "#1c7ed6";
}

/** The label for omp's skill source id (`native:project` is `Project`). */
export function sourceLabel(source: string): string {
  const known = SOURCE_LABELS[source];
  if (known !== undefined) return known;
  const provider = source.split(":")[0] ?? source;
  return provider === "" ? source : `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
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
  private discovery: Discovery | null = null;
  private discovering: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: CatalogDeps) {
    this.now = deps.now ?? Date.now;
  }

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

  /** Asks omp again when its last answer is older than `DISCOVERY_TTL_MS` (or `force`); joins a running ask. */
  refresh(force = false): Promise<void> {
    if (this.discovering !== null) return this.discovering;
    if (!force && this.discovery !== null && this.now() - this.discovery.at < DISCOVERY_TTL_MS) return Promise.resolve();
    this.discovering = this.discover().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }

  /** One row per skill name, sorted by name, from omp's last answer (none before the first). */
  entries(): CatalogEntry[] {
    const discovery = this.discovery;
    if (discovery === null) return [];
    const assistants = this.assistants();
    const disabled = this.disabledByProfile(assistants);
    const copies = new Map<string, SkillCopy[]>();
    /** Profiles whose sessions can load each name (before `disabledExtensions`). */
    const loadable = new Map<string, Set<string | null>>();
    const add = (copy: SkillCopy, profile: string | null): void => {
      const group = copies.get(copy.name) ?? [];
      if (!group.some((other) => other.source.file === copy.source.file)) group.push(copy);
      copies.set(copy.name, group);
      const profiles = loadable.get(copy.name) ?? new Set();
      profiles.add(profile);
      loadable.set(copy.name, profiles);
    };
    // The assistants' profiles first: their copy is the row's source. omp leaves out what a profile's
    // own config switched off; those come from the listing without config, so they can come back on.
    const order = [...new Set<string | null>([...assistants.map((assistant) => assistant.profile), null])];
    for (const profile of order) {
      for (const copy of discovery.byProfile.get(profile) ?? []) add(copy, profile);
      const own = configList(profile === null ? this.overlayPath() : this.profilePath(profile)) ?? [];
      for (const copy of discovery.bare) if (own.includes(`skill:${copy.name}`)) add(copy, profile);
    }
    const out: CatalogEntry[] = [];
    for (const [name, group] of copies) {
      const [primary, ...rest] = group;
      if (primary === undefined) continue;
      const profiles = loadable.get(name) ?? new Set();
      out.push({
        primary,
        row: {
          name,
          description: primary.description,
          source: primary.source,
          also: rest.map((copy) => copy.source),
          updatedAt: Math.round(walk(primary.realDir, MAX_SCAN).newest),
          usedBy: primary.disabled
            ? []
            : assistants.filter((assistant) => profiles.has(assistant.profile) && !(disabled.get(assistant.profile) ?? []).includes(`skill:${name}`)).map((assistant) => assistant.id),
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
    await this.refresh();
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
    let changed = false;
    for (const [profile, on] of wanted) {
      if (profile !== null && overlay !== undefined)
        throw new SkillError(409, `${this.overlayPath()} sets disabledExtensions for every profile; take it out there to switch skills per assistant`);
      const current = this.effectiveDisabled(profile);
      const next = on ? current.filter((item) => item !== extension) : current.includes(extension) ? current : [...current, extension];
      if (next.length === current.length && next.every((item, index) => item === current[index])) continue;
      const args = [...(profile === null ? [] : ["--profile", profile]), "config", "set", "disabledExtensions", JSON.stringify(next)];
      const result = await this.deps.run(args);
      if (result.code !== 0) throw new SkillError(502, `omp ${args.join(" ")} failed: ${(result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`).slice(0, 400)}`);
      changed = true;
    }
    if (changed) await this.refresh(true);
  }

  private overlayPath(): string {
    return join(this.deps.home, ".omp", "agent", "config.yml");
  }

  private profilePath(profile: string): string {
    return join(this.deps.home, ".omp", "profiles", profile, "agent", "config.yml");
  }


  /** Each assistant profile's effective list (and the default profile's), read once per listing. */
  private disabledByProfile(assistants: readonly Assistant[]): Map<string | null, string[]> {
    const out = new Map<string | null, string[]>();
    for (const profile of [null, ...assistants.map((assistant) => assistant.profile)]) if (!out.has(profile)) out.set(profile, this.effectiveDisabled(profile));
    return out;
  }

  private async discover(): Promise<void> {
    const profiles = [...new Set<string | null>([null, ...this.assistants().map((assistant) => assistant.profile)])];
    const empty = mkdtempSync(join(tmpdir(), "relay-skills-"));
    try {
      const [bare, ...lists] = await Promise.all([this.ask([], { PI_CODING_AGENT_DIR: empty }), ...profiles.map((profile) => this.ask(profile === null ? [] : ["--profile", profile]))]);
      if (bare === null || lists.some((list) => list === null)) return;
      const byProfile = new Map<string | null, SkillCopy[]>();
      profiles.forEach((profile, index) => byProfile.set(profile, lists[index] ?? []));
      this.discovery = { at: this.now(), byProfile, bare };
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }

  /** `omp <profileArgs> skill list --json` as copies; null (and logged) when omp fails. */
  private async ask(profileArgs: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<SkillCopy[] | null> {
    const args = [...profileArgs, "skill", "list", "--json"];
    const result = await this.deps.list(args, env);
    let json: unknown = undefined;
    try {
      json = JSON.parse(result.stdout) as unknown;
    } catch {
      // reported below
    }
    const parsed = result.code === 0 ? OmpSkillList.safeParse(json) : null;
    if (parsed?.success !== true) {
      this.deps.log?.(`skills: omp ${args.join(" ")} failed: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 300)}`);
      return null;
    }
    return parsed.data.skills.flatMap((skill) => {
      const copy = this.read(skill);
      return copy === null ? [] : [copy];
    });
  }

  /** omp's skill as a copy, `enabled: false` from its frontmatter. Null without a readable SKILL.md or a usable name. */
  private read(skill: OmpSkill): SkillCopy | null {
    if (!SKILL_NAME.test(skill.name)) return null;
    let text: string;
    let realDir: string;
    try {
      text = readFileSync(skill.filePath, "utf8");
      realDir = realpathSync(skill.baseDir);
    } catch {
      return null;
    }
    const home = this.deps.home;
    const dir = skill.baseDir;
    return {
      name: skill.name,
      description: skill.description,
      disabled: frontmatterData(splitFrontmatter(text).yaml)["enabled"] === false,
      realDir,
      source: { key: skill.source, label: sourceLabel(skill.source), dir: dir.startsWith(`${home}${sep}`) ? `~${dir.slice(home.length)}` : dir, file: skill.filePath },
    };
  }
}

/** The real `OmpRun`: `omp` (the resolved binary) in `cwd`, killed after 30 s; no inherited profile choice. */
export function ompRunner(omp: string, cwd: string): OmpRun {
  return (args, env = {}) => {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROFILE_ENV.includes(key)));
    execFile(omp, [...args], { cwd, timeout: 30_000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...base, ...env } }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, stdout, stderr: error !== null && stderr === "" ? error.message : stderr });
    });
    return promise;
  };
}
