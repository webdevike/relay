/**
 * Assistant portraits: DiceBear notionists, the generator Relay desktop uses for assistants and
 * Rooms, so an agent looks the same on both. The seed is the registry's `avatar` (sent by the host
 * on `assistant.agents`), else the agent's id. Pure SVG text; `ui/Portrait` draws it.
 */
import { createAvatar } from "@dicebear/core";
import * as notionists from "@dicebear/notionists";

const cache = new Map<string, string>();

/** The seed an agent's portrait is drawn from: its registry `avatar`, else its id. */
export function portraitSeed(agent: { id: string; avatar?: string | undefined }): string {
  const avatar = agent.avatar?.trim();
  return avatar === undefined || avatar === "" ? agent.id : avatar;
}

/** The notionists portrait for `seed` on a transparent background, as SVG markup; memoized per seed. */
export function portraitSvg(seed: string): string {
  let svg = cache.get(seed);
  if (svg === undefined) {
    // The license metadata is dropped: Skia's SVG parser has no use for RDF.
    svg = createAvatar(notionists, { seed, backgroundColor: ["transparent"] })
      .toString()
      .replace(/<metadata[\s\S]*?<\/metadata>/, "");
    cache.set(seed, svg);
  }
  return svg;
}
