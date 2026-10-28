// The assistant threads the host runs, read once at start from the agent home's registry,
// `<agentHome>/.omp/assistant/agents.json`: `{ "agents": [{ "id", "title", "scope"?, "avatar"?, ... }, ...] }`.
// `avatar` is a notionists seed, or a designed portrait `{ style, seed, options?, colors? }`.
// Each entry gets its own long-lived omp session, store file and prime. The first entry is the
// default, used only for phone requests that name no agent (builds from before there were several).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantAgentId, AssistantPortrait } from "@relay/protocol";
import { z } from "zod";

/** The registry, under the agent home. */
export const REGISTRY_FILE = join(".omp", "assistant", "agents.json");

export interface AssistantAgentConfig {
  /** `^[a-z][a-z0-9-]*$`; names the store file, the prime dir and `RELAY_ASSISTANT`. */
  readonly id: string;
  /** Shown on the phone, used as the push title, the herdr workspace label and the job-line prefix. */
  readonly title: string;
  /** What the agent covers, e.g. "eCard Systems work"; shown under its title on the phone. Absent when the registry has none. */
  readonly scope?: string;
  /** The omp profile (account) the agent's session runs under; absent means omp's default. */
  readonly profile?: "personal" | "work";
  /** The omp model the agent's session starts on (`omp --model`); absent means the profile's default. */
  readonly model?: string;
  /** The pocket-tts voice calls with the agent speak in (a catalog name such as "alba"); absent means the host's default. */
  readonly voice?: string;
  /** The GPT-Live voice live calls with the agent speak in (e.g. "marin"); absent means $RELAY_LIVE_VOICE, then "marin". */
  readonly liveVoice?: string;
  /** Seed of the agent's DiceBear portrait (the designed portrait's seed when there is one); absent means the clients seed it with `id`. */
  readonly avatar?: string;
  /** The registry's designed portrait (an object `avatar`), drawn instead of the notionists `avatar` by clients that know it. */
  readonly portrait?: AssistantPortrait;
}

const Registry = z
  .object({
    agents: z
      .array(
        z.object({
          id: AssistantAgentId,
          title: z.string().trim().min(1),
          scope: z.string().optional(),
          profile: z.enum(["personal", "work"]).optional(),
          model: z.string().trim().min(1).optional(),
          voice: z.string().trim().min(1).optional(),
          liveVoice: z.string().trim().min(1).optional(),
          avatar: z.union([z.string().trim().min(1), AssistantPortrait]).optional(),
        }),
      )
      .min(1),
  })
  .superRefine((registry, ctx) => {
    const seen = new Set<string>();
    for (const [index, agent] of registry.agents.entries()) {
      if (seen.has(agent.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", index, "id"], message: `duplicate id ${agent.id}` });
      seen.add(agent.id);
    }
  });

/** The registry's agents in file order. Throws with a readable message when the file is missing or invalid. */
export function loadRegistry(agentHome: string): readonly AssistantAgentConfig[] {
  const path = join(agentHome, REGISTRY_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = Registry.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data.agents.map(({ id, title, scope, profile, model, voice, liveVoice, avatar }) => {
    const trimmed = scope?.trim();
    return {
      id,
      title,
      ...(trimmed === undefined || trimmed === "" ? {} : { scope: trimmed }),
      ...(profile === undefined ? {} : { profile }),
      ...(model === undefined ? {} : { model }),
      ...(voice === undefined ? {} : { voice }),
      ...(liveVoice === undefined ? {} : { liveVoice }),
      ...(avatar === undefined ? {} : typeof avatar === "string" ? { avatar } : { avatar: avatar.seed, portrait: avatar }),
    };
  });
}

/** The GPT-Live voice of agent `id`: its registry `liveVoice`, else `envVoice` ($RELAY_LIVE_VOICE), else "marin". */
export function liveVoiceFor(agents: readonly { readonly id: string; readonly liveVoice?: string | undefined }[], id: string, envVoice: string | undefined): string {
  return agents.find((agent) => agent.id === id)?.liveVoice ?? envVoice ?? "marin";
}
