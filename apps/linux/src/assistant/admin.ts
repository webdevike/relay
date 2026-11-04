// Writes the assistant registry (`<agentHome>/.omp/assistant/agents.json`) and watches it:
//   - `create` adds an entry (unique id, title and avatar seed), scaffolds the new assistant's
//     prime.md (the setup interview, `onboarding.ts`) and its thread memory from the home's
//     `.omp/assistant/thread.template.md`;
//   - `update` changes fields of one entry (what an assistant's `assistant set` sends);
//   - `retire` takes an entry out (kept in `.omp/assistant/retired.json`; its prime and memory stay);
//   - every change, written here or by hand, reaches `onChange` with the reread registry, which the
//     host hands to its threads (`AssistantThreads.reload`), so phones and desktops see it at once.
// Writes are whole-file (tmp + rename) and keep fields and entries this code does not know.

import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AssistantAgentId, AssistantPortrait } from "@relay/protocol";
import { z } from "zod";
import { AVATARS_PER_PAGE, LIVE_VOICES, onboardingPrime } from "./onboarding";
import { avatarSeed, loadRegistry, Registry, REGISTRY_FILE, RegistryError, type AssistantAgentConfig } from "./registry";
import { primeFile } from "./service";

/** Where retired entries are kept, under the agent home. */
export const RETIRED_FILE = join(".omp", "assistant", "retired.json");
/** The thread memory template a new assistant's `thread.md` starts from, under the agent home. */
export const THREAD_TEMPLATE_FILE = join(".omp", "assistant", "thread.template.md");
/** Longest title: the phone shows it as a heading and the push title. */
export const MAX_TITLE = 40;
/** Longest scope: one line under the title. */
export const MAX_SCOPE = 200;
/** Longest id. */
export const MAX_ID = 32;
/** How long the watcher lets a burst of writes settle before rereading. */
export const WATCH_SETTLE_MS = 200;

/**
 * Portrait colors by position: the setup wizard's (`AVATAR_PALETTE` in the desktop's
 * renderer/setup/run.ts, `scaffold-home.sh`); keep the three in step.
 */
export const AVATAR_PALETTE: readonly { readonly paper: string; readonly accent: string }[] = [
  { paper: "#ffe3e3", accent: "#1c7ed6" },
  { paper: "#e7f5ff", accent: "#f76707" },
  { paper: "#ebfbee", accent: "#2f9e44" },
  { paper: "#fff3bf", accent: "#e03131" },
  { paper: "#f3d9fa", accent: "#7048e8" },
  { paper: "#d0ebff", accent: "#0c8599" },
];

/** One registry entry as stored, unknown fields included. */
export type RawEntry = Record<string, unknown> & { readonly id: string; readonly title: string };

const Profile = z.enum(["personal", "work"]);
const Avatar = z.union([z.string().trim().min(1), AssistantPortrait]);

/** A new assistant: a title, the rest optional (the id comes from the title). */
export const AssistantDraft = z.object({
  id: AssistantAgentId.max(MAX_ID).optional(),
  title: z.string().trim().min(1).max(MAX_TITLE),
  scope: z.string().trim().max(MAX_SCOPE).optional(),
  profile: Profile.optional(),
  model: z.string().trim().min(1).optional(),
  voice: z.string().trim().min(1).optional(),
  liveVoice: z.string().trim().min(1).optional(),
  avatar: Avatar.optional(),
});
export type AssistantDraft = z.infer<typeof AssistantDraft>;

/** A change to one entry; `null` clears an optional field. `avatarChoice` picks face n of the last `offerAvatars`. */
export const AssistantPatch = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE),
    scope: z.string().trim().max(MAX_SCOPE).nullable(),
    profile: Profile.nullable(),
    model: z.string().trim().min(1).nullable(),
    voice: z.string().trim().min(1).nullable(),
    liveVoice: z.string().trim().min(1).nullable(),
    avatar: Avatar.nullable(),
    avatarChoice: z.number().int().min(1),
  })
  .partial()
  .strict();
export type AssistantPatch = z.infer<typeof AssistantPatch>;

/** One field an update changed, for the assistant to report ("scope: Personal -> Driving"). */
export interface FieldChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** One face offered by `offerAvatars`. */
export interface AvatarOffer {
  readonly n: number;
  readonly portrait: AssistantPortrait;
}

export interface AssistantRegistryDeps {
  readonly agentHome: string;
  /** Who the assistants work for (host.json `human`). */
  readonly userName: () => string;
  /** The host CLI an assistant runs (`bun "<main.ts>"`, or the app's binary). */
  readonly cli: string;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** Watches a directory, calling back with the changed file's name (`fs.watch`; a test seam). */
  readonly watchDir?: (dir: string, changed: (name: string | null) => void) => { close(): void };
}

/** `Drive Buddy` -> `drive-buddy`, a valid registry id (`a-` before a leading digit); empty when nothing usable is left. */
export function idFromTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID)
    .replace(/-+$/, "");
  return slug === "" ? "" : /^[a-z]/.test(slug) ? slug : `a-${slug}`.slice(0, MAX_ID);
}

/** Where agent `id`'s thread memory lives: Eva's `work/eva/agents/` when the home has it, else a starter home's `work/agents/`. */
export function threadFile(agentHome: string, id: string): string {
  const eva = existsSync(join(agentHome, "work", "eva", "agents"));
  return join("work", ...(eva ? ["eva"] : []), "agents", id, "thread.md");
}

/** Where the faces last offered to `id` are kept, so `avatarChoice` n means what the user tapped. */
export function avatarChoicesFile(id: string): string {
  return join(".omp", "assistant", "agents", id, "avatar-choices.json");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export class AssistantRegistry {
  /** Gets the registry after every change that parses (a broken hand edit is logged and skipped). */
  onChange: ((agents: readonly AssistantAgentConfig[]) => void) | null = null;
  /** The file text last handed to `onChange`, so a write and its own watch event reload once. */
  private seen: string | null = null;

  constructor(private readonly deps: AssistantRegistryDeps) {}

  private get path(): string {
    return join(this.deps.agentHome, REGISTRY_FILE);
  }

  /** The stored entries in file order. */
  list(): RawEntry[] {
    return this.read().agents;
  }

  /**
   * Adds `draft` and scaffolds its prime.md (the setup interview) and thread.md; existing files are
   * kept, so a returning assistant keeps its instructions. Throws `RegistryError` for a taken or
   * invalid id, title or avatar seed.
   */
  create(input: unknown): RawEntry {
    const draft = parse(AssistantDraft, input);
    const registry = this.read();
    const id = draft.id ?? idFromTitle(draft.title);
    if (id === "") throw new RegistryError(`cannot make an id from "${draft.title}"; pass an id`);
    if (registry.agents.some((agent) => agent.id === id)) throw new RegistryError(`an assistant with id ${id} already exists`);
    const taken = new Set(registry.agents.map((agent) => avatarSeed(agent)));
    let seed = id;
    for (let n = 2; taken.has(seed); n++) seed = `${id}-${String(n)}`;
    const colors = AVATAR_PALETTE[registry.agents.length % AVATAR_PALETTE.length];
    const entry: RawEntry = {
      id,
      title: draft.title,
      ...(draft.scope === undefined || draft.scope === "" ? {} : { scope: draft.scope }),
      ...(draft.profile === undefined ? {} : { profile: draft.profile }),
      ...(draft.model === undefined ? {} : { model: draft.model }),
      ...(draft.voice === undefined ? {} : { voice: draft.voice }),
      ...(draft.liveVoice === undefined ? {} : { liveVoice: draft.liveVoice }),
      avatar: draft.avatar ?? { style: "micah", seed, ...(colors === undefined ? {} : { colors: { ...colors } }) },
    };
    const agents = [...registry.agents, entry];
    check(agents, entry);
    this.scaffold(entry, registry.agents);
    this.write({ ...registry, agents });
    this.deps.log(`assistant registry: created ${entry.title} (${id})`);
    return entry;
  }

  /** Applies `patch` to agent `id`; returns what changed (empty when nothing did). */
  update(id: string, input: unknown): FieldChange[] {
    const patch = parse(AssistantPatch, input);
    const registry = this.read();
    const index = registry.agents.findIndex((agent) => agent.id === id);
    const before = registry.agents[index];
    if (before === undefined) throw new RegistryError(`no assistant ${id}`);
    const { avatarChoice, ...fields } = patch;
    // A null or empty value clears its field; the others replace in place, new ones go last.
    const cleared = new Set(Object.entries(fields).flatMap(([field, value]) => (value === null || value === "" ? [field] : [])));
    const next: Record<string, unknown> = Object.fromEntries(
      [...Object.entries(before), ...Object.entries(fields)].filter(([field]) => !cleared.has(field)),
    );
    if (avatarChoice !== undefined) next["avatar"] = this.offered(id, avatarChoice);
    const entry = next as RawEntry;
    const agents = registry.agents.map((agent, at) => (at === index ? entry : agent));
    check(agents, entry);
    const changes: FieldChange[] = [];
    for (const field of new Set([...Object.keys(before), ...Object.keys(entry)])) {
      if (JSON.stringify(before[field]) !== JSON.stringify(entry[field])) changes.push({ field, from: before[field] ?? null, to: entry[field] ?? null });
    }
    if (changes.length === 0) return changes;
    this.write({ ...registry, agents });
    this.deps.log(`assistant registry: ${id} changed ${changes.map((change) => change.field).join(", ")}`);
    return changes;
  }

  /** Takes agent `id` out of the registry into `retired.json`; its prime.md and thread memory stay. The last agent cannot be retired. */
  retire(id: string): RawEntry {
    const registry = this.read();
    const entry = registry.agents.find((agent) => agent.id === id);
    if (entry === undefined) throw new RegistryError(`no assistant ${id}`);
    if (registry.agents.length === 1) throw new RegistryError(`${entry.title} is the only assistant; create another before retiring it`);
    const retiredPath = join(this.deps.agentHome, RETIRED_FILE);
    let retired: unknown[] = [];
    try {
      const parsed = readJson(retiredPath) as { retired?: unknown };
      if (Array.isArray(parsed.retired)) retired = parsed.retired;
    } catch {
      // None retired yet.
    }
    writeAtomic(retiredPath, `${JSON.stringify({ retired: [...retired, { ...entry, retiredAt: new Date(this.deps.now?.() ?? Date.now()).toISOString() }] }, null, 2)}\n`);
    this.write({ ...registry, agents: registry.agents.filter((agent) => agent.id !== id) });
    this.deps.log(`assistant registry: retired ${entry.title} (${id})`);
    return entry;
  }

  /**
   * Page `page` of faces for agent `id` (micah, seeds `<id>-<n>` not used by another agent,
   * the palette's colors); remembered so `update(id, { avatarChoice: n })` takes face n.
   */
  offerAvatars(id: string, page: number): AvatarOffer[] {
    const registry = this.read();
    if (!registry.agents.some((agent) => agent.id === id)) throw new RegistryError(`no assistant ${id}`);
    const taken = new Set(registry.agents.filter((agent) => agent.id !== id).map((agent) => avatarSeed(agent)));
    const offers: AvatarOffer[] = [];
    for (let n = (page - 1) * AVATARS_PER_PAGE + 1; offers.length < AVATARS_PER_PAGE; n++) {
      let seed = `${id}-${String(n)}`;
      for (let k = 2; taken.has(seed); k++) seed = `${id}-${String(n)}-${String(k)}`;
      const colors = AVATAR_PALETTE[(n - 1) % AVATAR_PALETTE.length];
      offers.push({ n, portrait: { style: "micah", seed, ...(colors === undefined ? {} : { colors: { ...colors } }) } });
    }
    const file = join(this.deps.agentHome, avatarChoicesFile(id));
    let kept: AvatarOffer[] = [];
    try {
      kept = z.array(z.object({ n: z.number(), portrait: AssistantPortrait })).parse(readJson(file));
    } catch {
      // First offer.
    }
    const byN = new Map([...kept, ...offers].map((offer) => [offer.n, offer]));
    writeAtomic(file, `${JSON.stringify([...byN.values()].sort((a, b) => a.n - b.n), null, 2)}\n`);
    return offers;
  }

  /** Rereads the file and hands it to `onChange` when it changed and parses; a broken file is logged and the threads keep the last good list. */
  reload(): void {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      this.deps.log(`assistant registry: cannot read ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (text === this.seen) return;
    let agents: readonly AssistantAgentConfig[];
    try {
      agents = loadRegistry(this.deps.agentHome);
    } catch (error) {
      this.deps.log(`assistant registry: keeping the last good list: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.seen = text;
    this.onChange?.(agents);
  }

  /** Reloads whenever `agents.json` changes (its directory is watched: a write lands as a rename). Returns the stop function. */
  watch(): () => void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    this.seen ??= existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
    let timer: Timer | undefined;
    const watchDir =
      this.deps.watchDir ??
      ((path, changed) =>
        watch(path, (_event, name) => {
          changed(name);
        }));
    const watcher = watchDir(dir, (name) => {
      if (name !== null && name !== "agents.json") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.reload();
      }, WATCH_SETTLE_MS);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }

  private read(): { agents: RawEntry[] } & Record<string, unknown> {
    let raw: unknown;
    try {
      raw = readJson(this.path);
    } catch (error) {
      throw new Error(`cannot read ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const agents = (raw as { agents?: unknown } | null)?.agents;
    if (typeof raw !== "object" || raw === null || !Array.isArray(agents)) throw new Error(`invalid ${this.path}: no agents list`);
    return { ...(raw as Record<string, unknown>), agents: agents as RawEntry[] };
  }

  private write(registry: { agents: RawEntry[] } & Record<string, unknown>): void {
    writeAtomic(this.path, `${JSON.stringify(registry, null, 2)}\n`);
    this.reload();
  }

  private offered(id: string, n: number): AssistantPortrait {
    let offers: AvatarOffer[] = [];
    try {
      offers = z.array(z.object({ n: z.number(), portrait: AssistantPortrait })).parse(readJson(join(this.deps.agentHome, avatarChoicesFile(id))));
    } catch {
      // Nothing offered yet.
    }
    const offer = offers.find((candidate) => candidate.n === n);
    if (offer === undefined) throw new RegistryError(`no avatar ${String(n)} was offered to ${id}; run \`assistant avatars --agent ${id}\` first`);
    return offer.portrait;
  }

  /** The new assistant's prime.md (the setup interview) and thread.md, unless they exist. */
  private scaffold(entry: RawEntry, others: readonly RawEntry[]): void {
    const home = this.deps.agentHome;
    const userName = this.deps.userName();
    const prime = join(home, primeFile(entry.id));
    const thread = threadFile(home, entry.id);
    if (!existsSync(prime)) {
      const handoff = existsSync(join(home, ".omp", "tools", "eva-thread.ts"))
        ? `bun .omp/tools/eva-thread.ts --agent <id> "<what was asked, with any link>"`
        : `${this.deps.cli} assistant say --agent <id> "<what was asked, with any link>"`;
      writeAtomic(
        prime,
        `${onboardingPrime({
          id: entry.id,
          title: entry.title,
          scope: typeof entry["scope"] === "string" ? entry["scope"] : "",
          userName,
          cli: this.deps.cli,
          threadFile: thread,
          others: others.map((agent) => `${agent.title} (${agent.id})${typeof agent["scope"] === "string" ? `: ${agent["scope"]}` : ""}`),
          handoff,
        })}\n`,
      );
    }
    const threadPath = join(home, thread);
    if (!existsSync(threadPath)) {
      let template = "# Thread memory\n\n## About {{userName}} lately\n- (nothing yet)\n\n## Tracking\n- (nothing yet)\n\n## Promised\n- (nothing yet)\n";
      try {
        template = readFileSync(join(home, THREAD_TEMPLATE_FILE), "utf8");
      } catch {
        // A home without the template gets the bare sections.
      }
      writeAtomic(threadPath, template.replaceAll("{{userName}}", userName));
    }
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new RegistryError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
  return parsed.data;
}

/**
 * Throws `RegistryError` unless `agents` is a valid registry in which `entry` (the one being
 * written) has a title, avatar seed and live voice of its own. Duplicates among the other entries
 * (hand-written before this check existed) are left alone.
 */
export function check(agents: readonly RawEntry[], entry: RawEntry): void {
  const others = agents.filter((agent) => agent !== entry);
  const title = entry.title.trim().toLowerCase();
  if (others.some((agent) => agent.title.trim().toLowerCase() === title)) throw new RegistryError(`an assistant called ${entry.title} already exists`);
  const seed = avatarSeed(entry);
  const owner = others.find((agent) => avatarSeed(agent) === seed);
  if (owner !== undefined) throw new RegistryError(`avatar seed ${seed} is already ${owner.title}'s; pick another face`);
  const liveVoice = entry["liveVoice"];
  if (liveVoice !== undefined && !(LIVE_VOICES as readonly unknown[]).includes(liveVoice)) throw new RegistryError(`liveVoice must be one of ${LIVE_VOICES.join(", ")}`);
  const voice = entry["voice"];
  if (voice !== undefined && (typeof voice !== "string" || !/^[\w./-]+$/.test(voice))) throw new RegistryError("voice must be a pocket-tts voice name or file path");
  const model = entry["model"];
  if (model !== undefined && (typeof model !== "string" || /\s/.test(model))) throw new RegistryError("model must be an omp model name such as anthropic/claude-sonnet-4-5");
  if (typeof entry["scope"] === "string" && entry["scope"].length > MAX_SCOPE) throw new RegistryError(`scope is longer than ${String(MAX_SCOPE)} characters`);
  const parsed = Registry.safeParse({ agents });
  if (!parsed.success) throw new RegistryError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
}
