// Portraits for agents that join a canvas room, drawn like the people in Relay Desktop's Rooms
// (evaos-electron renderer/rooms/roster.ts + ui/portrait.ts): a DiceBear notionists face seeded by
// the name in lowercase-dash form, so "Mara Voss" looks the same on a board as in a room. Offline,
// deterministic, served as SVG at `/canvas/portrait/<seed>`.

import { createAvatar } from "@dicebear/core";
import type { AgentSession, CanvasAgent } from "@relay/protocol";
import { assistantAvatarSvg, assistantPortrait } from "@relay/portrait-motion";
import type { AssistantAgentConfig } from "../assistant/registry";
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

/** The SVG behind `/canvas/avatar/<key>`: registry assistant `key` drawn by the shared function Relay desktop's AgentPortrait uses (`assistantAvatarSvg`), else null. */
export function assistantAvatar(registry: readonly AssistantAgentConfig[], key: string): string | null {
  const config = registry.find((entry) => entry.id === key);
  return config === undefined ? null : assistantAvatarSvg(assistantPortrait(config));
}

/** Default look of the agent of a plain chat (Relay calls those chats' agent Eva). */
export const EVA_LOOK: CanvasAgent = { name: "Eva", color: "#8b5cf6" };

/** Assistant `id` as the registry draws it: its title, accent and avatar (the shared desktop portrait) when it is listed. */
export function assistantLook(registry: readonly AssistantAgentConfig[], id: string, fallbackTitle: string): CanvasAgent {
  const config = registry.find((entry) => entry.id === id);
  const accent = config?.portrait?.colors?.accent;
  const agent: CanvasAgent = { name: config?.title ?? fallbackTitle, color: accent !== undefined && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : EVA_LOOK.color };
  return config === undefined ? agent : { ...agent, avatar: `/canvas/avatar/${id}` };
}

/**
 * The session `session` belongs to at the top (a helper's parent chain walked up) and the
 * registry assistant whose face it wears there: an assistant's own thread, or work an assistant
 * started (`owner`); undefined for a plain chat.
 */
export function sessionAssistant(sessions: readonly AgentSession[], session: AgentSession): { top: AgentSession; assistant: string | undefined } {
  let top = session;
  for (let depth = 0; depth < 8 && top.parentId !== undefined; depth++) {
    const parent = sessions.find((s) => s.id === top.parentId);
    if (parent === undefined) break;
    top = parent;
  }
  return { top, assistant: top.kind === "assistant" ? top.assistant : top.owner };
}

/** The registry assistant named `name` (its id or title, any case), if any. */
export function assistantNamed(registry: readonly AssistantAgentConfig[], name: string): AssistantAgentConfig | undefined {
  const key = name.trim().toLowerCase();
  return registry.find((entry) => entry.id === key || entry.title.toLowerCase() === key);
}
