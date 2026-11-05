// The Skills page's wire types (proof/skills-page/CONTRACT.md section 3), as the host serves them.

/** Where a copy of a skill lives; omp loads the first by precedence eva, omp, plugin, claude, agents. */
export type SourceKey = "eva" | "omp" | "agents" | "claude" | "plugin";

export interface SkillSource {
  key: SourceKey;
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
  /** Newest `skill://<name>` read in the last 30 days of omp sessions. */
  lastUsedAt: number | null;
}

export interface SkillList {
  skills: SkillRow[];
  assistants: Assistant[];
}

export interface SkillDetail extends SkillRow {
  files: { path: string; size: number }[];
  usage: { lastUsedAt: number | null; lastUsedBy: string | null; loads30d: number };
  /** The profile each assistant runs, so the UI can say toggles are shared. */
  profiles: Record<string, string | null>;
}

/** A skill name in routes and on disk: bare (`canvas`), or plugin-namespaced with `:`. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

/** A refused skills request; `status` is the HTTP status the routes answer with. */
export class SkillError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
