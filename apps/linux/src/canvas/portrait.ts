// Portraits for agents that join a canvas room, drawn like the people in Relay Desktop's Rooms
// (evaos-electron renderer/rooms/roster.ts + ui/portrait.ts): a DiceBear notionists face seeded by
// the name in lowercase-dash form, so "Mara Voss" looks the same on a board as in a room. Offline,
// deterministic, served as SVG at `/canvas/portrait/<seed>`.

import { createAvatar } from "@dicebear/core";
import * as notionists from "@dicebear/notionists";

/** `Mara Voss` -> `mara-voss` (Rooms' seed), kept to what the portrait route accepts. */
export function portraitSeed(name: string): string {
  const seed = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60);
  return seed === "" ? "agent" : seed;
}

const drawn = new Map<string, string>();

/** The SVG for `seed` (on a transparent background); the same seed always draws the same face. */
export function portraitSvg(seed: string): string {
  let svg = drawn.get(seed);
  if (svg === undefined) {
    svg = createAvatar(notionists, { seed, backgroundColor: ["transparent"] }).toString();
    drawn.set(seed, svg);
  }
  return svg;
}
