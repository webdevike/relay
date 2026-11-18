/**
 * An assistant's registry model is omp's `provider/id`, optionally with a thinking suffix:
 * `anthropic/claude-opus-5-5:high`. The avatar menu edits it; the host applies it on the assistant's
 * next session start.
 */

/** Every level omp names, low to high; the suffix is only read as a level when it is one of these. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ModelParts {
  /** `provider/id`, no suffix. */
  base: string;
  /** The thinking suffix, when the string carries one. */
  level: string | undefined;
}

/** Splits `provider/id[:level]`; a colon that is part of the model id (`x:free`) stays in `base`. */
export function splitModel(model: string): ModelParts {
  const colon = model.lastIndexOf(":");
  if (colon < 0) return { base: model, level: undefined };
  const level = model.slice(colon + 1);
  return (LEVELS as readonly string[]).includes(level)
    ? { base: model.slice(0, colon), level }
    : { base: model, level: undefined };
}

export function joinModel(base: string, level: string | undefined): string {
  return level === undefined || level === "" ? base : `${base}:${level}`;
}

/**
 * The level a model takes when switching to it from `wanted`: the same one, else the nearest lower
 * one it has (a model without `xhigh` gets `high`), else its first. Undefined when it takes none.
 */
export function levelFor(
  levels: readonly string[],
  wanted: string | undefined,
): string | undefined {
  if (levels.length === 0) return undefined;
  if (wanted === undefined) return levels.includes("medium") ? "medium" : levels[0];
  if (levels.includes(wanted)) return wanted;
  const rank = (LEVELS as readonly string[]).indexOf(wanted);
  for (let at = rank - 1; at >= 0; at -= 1) {
    const lower = LEVELS[at];
    if (lower !== undefined && levels.includes(lower)) return lower;
  }
  return levels[0];
}

/** "xhigh" reads Extra high, else capitalised. */
export function levelLabel(level: string): string {
  return level === "xhigh" ? "Extra high" : level.charAt(0).toUpperCase() + level.slice(1);
}

/** "Claude Opus 5.5" reads "Opus 5.5": the prefix adds nothing in a list of models. */
export function shortModelName(name: string): string {
  return name.replace(/^Claude\s+/i, "");
}

/** The model entry the menu shows as chosen (the registry's, else the running session's by name) and its level (the registry's suffix, else the session's). */
export function resolveCurrent<M extends { provider: string; id: string; name: string }>(
  models: readonly M[],
  registryModel: string | undefined,
  sessionModelName: string | undefined,
  sessionLevel: string | undefined,
): { model: M | undefined; level: string | undefined } {
  const parts = registryModel === undefined ? undefined : splitModel(registryModel);
  const model =
    (parts === undefined
      ? undefined
      : models.find((entry) => `${entry.provider}/${entry.id}` === parts.base)) ??
    models.find((entry) => entry.name === sessionModelName);
  return { model, level: parts?.level ?? sessionLevel };
}
