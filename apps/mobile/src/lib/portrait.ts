/**
 * Assistant portraits: DiceBear, the generator Relay desktop uses for assistants and Rooms, so an
 * agent looks the same on both. An agent's portrait is its registry's designed `portrait` (a style
 * such as micah, its seed, part options and colors, sent by the host on `assistant.agents`), else
 * notionists seeded with its `avatar`, else with its id. Pure SVG text; `ui/Portrait` draws it.
 */
import { createAvatar, type Style } from "@dicebear/core";
import * as micah from "@dicebear/micah";
import * as notionists from "@dicebear/notionists";
import type { AssistantPortrait, PortraitStyle } from "@relay/protocol";

const STYLES: Record<PortraitStyle, Style<object>> = { notionists, micah };

/** Seed-only portraits, one object per seed so store selectors return a stable value. */
const seeded = new Map<string, AssistantPortrait>();
const drawn = new Map<string, string>();

/** The portrait an agent is drawn with: its designed `portrait`, else notionists from its `avatar` seed, else from its id. */
export function portraitOf(agent: { id: string; avatar?: string | undefined; portrait?: AssistantPortrait | undefined }): AssistantPortrait {
  if (agent.portrait !== undefined) return agent.portrait;
  const avatar = agent.avatar?.trim();
  const seed = avatar === undefined || avatar === "" ? agent.id : avatar;
  let portrait = seeded.get(seed);
  if (portrait === undefined) {
    portrait = { style: "notionists", seed };
    seeded.set(seed, portrait);
  }
  return portrait;
}

/** `portrait` on a transparent background, as SVG markup; memoized per portrait. */
export function portraitSvg(portrait: AssistantPortrait): string {
  const key = JSON.stringify([portrait.style, portrait.seed, portrait.options ?? {}]);
  let svg = drawn.get(key);
  if (svg === undefined) {
    // The license metadata is dropped: Skia's SVG parser has no use for RDF.
    svg = createAvatar(STYLES[portrait.style], { ...portrait.options, seed: portrait.seed, backgroundColor: ["transparent"] })
      .toString()
      .replace(/<metadata[\s\S]*?<\/metadata>/, "");
    drawn.set(key, svg);
  }
  return svg;
}
