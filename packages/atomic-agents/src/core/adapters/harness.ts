import type { GenerateRequest } from "../Model.ts";

/**
 * An omp model id (`openai-codex/gpt-6-astra`) as a native harness names it (`gpt-6-astra`), when its provider is one
 * the harness runs; a bare id passes as is. Anything else is not that harness's model.
 */
export const nativeModel = (model: string, providers: ReadonlyArray<string>) => {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  return providers.includes(model.slice(0, slash)) ? model.slice(slash + 1) : undefined;
};

/**
 * omp's thinking level as a native harness's effort flag. Codex (`model_reasoning_effort`) and Claude Code (`--effort`)
 * take a level, not off: `off` and `minimal` run at `low`, the lowest both accept. Unset keeps the harness default.
 */
export const harnessEffort = (thinking: GenerateRequest["thinking"]) =>
  thinking === "off" || thinking === "minimal" ? "low" : thinking;
