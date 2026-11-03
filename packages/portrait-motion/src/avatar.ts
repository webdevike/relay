/**
 * The one still assistant avatar: what Relay desktop's AgentPortrait, the canvas host's
 * `/canvas/avatar/<key>` and everything else that draws an assistant's face share. A string is a
 * notionists seed on a transparent background; a designed portrait draws its DiceBear style and
 * part options on its `colors.paper`, when it has one.
 */
import { createAvatar, type Style } from "@dicebear/core";
import * as micah from "@dicebear/micah";
import * as notionists from "@dicebear/notionists";
import type { Portrait, PortraitStyle } from "./rig";

const STYLES: Record<PortraitStyle, Style<object>> = { notionists, micah };

const drawn = new Map<string, string>();

/** The registry's portrait for an assistant: its designed one, else notionists from its `avatar` seed, else from its id. */
export function assistantPortrait(agent: { id: string; avatar?: string | undefined; portrait?: Portrait | undefined }): Portrait {
  if (agent.portrait !== undefined) return agent.portrait;
  const seed = agent.avatar?.trim();
  return { style: "notionists", seed: seed === undefined || seed === "" ? agent.id : seed };
}

/** `of` as SVG markup; deterministic, memoized, no network. */
export function assistantAvatarSvg(of: string | Portrait): string {
  const p: Portrait = typeof of === "string" ? { style: "notionists", seed: of } : of;
  const paper = p.colors?.paper;
  const key = JSON.stringify([p.style, p.seed, p.options ?? {}, paper ?? null]);
  let svg = drawn.get(key);
  if (svg === undefined) {
    svg = createAvatar(STYLES[p.style], {
      ...p.options,
      seed: p.seed,
      backgroundColor: [paper === undefined ? "transparent" : paper.slice(1)],
    }).toString();
    drawn.set(key, svg);
  }
  return svg;
}
