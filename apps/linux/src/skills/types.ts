// The Skills page's wire types (proof/skills-page/CONTRACT.md section 3), as the host serves them.

export interface SkillSource {
  /** omp's source id: `native:project`, `native:user`, `agents:user`, `claude:project`, a plugin's, ... */
  key: string;
  /** `Project`, `User`, `Agents`, `Claude project`, ... */
  label: string;
  /** The skill's folder for display, `~` for home. */
  dir: string;
  /** Absolute SKILL.md path. */
  file: string;
}

export interface Assistant {
  id: string;
  title: string;
  profile: string | null;
  /** avatar.colors.accent */
  color: string;
}

export interface SkillRow {
  name: string;
  description: string;
  /** The copy omp loads. */
  source: SkillSource;
  /** Other copies of the same name (symlinked or differing). */
  also: SkillSource[];
  /** ms, newest mtime in the skill folder. */
  updatedAt: number;
  /** Assistant ids that load it. */
  usedBy: string[];
  /** SKILL.md frontmatter `enabled: false`. */
  disabled: boolean;
  /** Newest load anywhere (skills/usage.ts); null when never. */
  lastUsedAt: number | null;
  /** Loads ever; null while the first usage scan runs. */
  uses: number | null;
  /** Where it was installed from (a skills lock's source, or the repo or plugin folder a linked skill lives in); null when written in place. */
  package: string | null;
  /** Which tool loads it: omp's folders, Claude Code's, or both. */
  origin: "omp" | "claude" | "both";
}

/** Loads of one skill by one runner (skills/usage.ts `Runner`). */
export interface SkillAgentUses {
  /** An assistant id, omp agent (`scout`, `session` for the default), job name, `eren`, `elysia`, `claude-code` or `other`. */
  agent: string;
  kind: "assistant" | "session" | "subagent" | "job" | "background" | "claude" | "other";
  /** The assistant it worked for; null when none or unknown. */
  owner: string | null;
  uses: number;
  lastUsedAt: number;
}

export interface SkillStats {
  uses: number;
  uses7d: number;
  uses30d: number;
  lastUsedAt: number | null;
  firstUsedAt: number | null;
  /** Most uses first. */
  byAgent: SkillAgentUses[];
  /** Loads per local day for the last 30 days, oldest first, today last. */
  daily: number[];
}

export interface SkillList {
  skills: SkillRow[];
  assistants: Assistant[];
}

export interface SkillDetail extends SkillRow {
  files: { path: string; size: number }[];
  /** Null while the first usage scan runs. */
  stats: SkillStats | null;
  /** The profile each assistant runs, so the UI can say toggles are shared. */
  profiles: Record<string, string | null>;
}

/**
 * A skill name in routes and on disk: bare (`canvas`), plugin-namespaced with `:`, or omp's
 * `<source>/<name>` for a copy whose name another source already took (`agents/hallmark`).
 */
export const SKILL_NAME = /^[a-z0-9][a-z0-9._:-]{0,79}(?:\/[a-z0-9][a-z0-9._:-]{0,79})?$/;

/** A refused skills request; `status` is the HTTP status the routes answer with. */
export class SkillError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
