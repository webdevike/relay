/**
 * Design systems a prototype (a canvas `proto` node) draws with: the Mantine theme, CSS variables,
 * fonts and components of a real product, so a mockup for it looks like it.
 *
 * - `relay`: Relay Desktop's own look (`relay.ts`).
 * - `ecard`: eCard's design-system layer, a snapshot from its repo (`ecard.ts`,
 *   generated/ecard/, refreshed by scripts/sync-ecard-design.ts).
 * - `mantine`: stock Mantine, no theme.
 *
 * The runtime side (theme objects, components) is runtime/systems.tsx; the page side (global CSS,
 * fonts) is `css.ts`. This module is data only, safe for the host to import.
 */
export const DESIGN_SYSTEMS = ["relay", "ecard", "mantine"] as const;
export type DesignSystem = (typeof DESIGN_SYSTEMS)[number];

export function isDesignSystem(value: unknown): value is DesignSystem {
  return (DESIGN_SYSTEMS as readonly unknown[]).includes(value);
}

/**
 * A component card's frame: the real Relay surface it is designed for, at that surface's size in
 * CSS px. The card draws its page at exactly this size (1:1, clipped, never stretched), so what
 * the board shows is what ships. Widths are the surface's own CSS width; heights are what the
 * surface gets in the app's default 1280 x 800 window (main/window.ts). The e2e canvas-frames
 * spec measures every one of them in the running app.
 */
export const FRAME_PRESETS = {
  /** main/window.ts: a new window's bounds. */
  window: { label: "Desktop window", w: 1280, h: 800 },
  /** tokens.css `--eva-page-w` (Assistants, Boards, Jobs, Habits, Dashboard, Reviews); the page body under its 44px header. */
  page: { label: "Page", w: 1120, h: 684 },
  /** tokens.css `--eva-page-w-narrow` (Settings, Meetings, Setup). */
  "page-narrow": { label: "Narrow page", w: 720, h: 684 },
  /** tokens.css `--eva-chat-column-w`: the chat log's column, header to pane bottom. */
  chat: { label: "Chat column", w: 780, h: 684 },
  /**
   * strips.css `.eva-chips`, the chip strip over the composer (subagent session badges), in
   * the band of the chat pane it sits in: 780 wide (the chat column) between 20px gutters, 33 tall
   * under its 10px top margin.
   */
  chips: { label: "Chat chip strip", w: 820, h: 43 },
  /** shell-core TOOL_PANE_SHARE (0.34 of the panes) in the default window: Files, Canvas, Browser. */
  pane: { label: "Tool pane", w: 331, h: 728 },
  /** shell-core SIDEBAR_DEFAULT, the window's full height. */
  sidebar: { label: "Sidebar", w: 272, h: 800 },
  /** tiling/dock/AddMenu.tsx: the Add tab popover (240 wide, its list at most 360 tall). */
  menu: { label: "Add tab menu", w: 240, h: 384 },
  /** The phone app: an iPhone's portrait screen in points. */
  phone: { label: "Phone", w: 390, h: 844 },
} as const satisfies Record<string, { label: string; w: number; h: number }>;
export type FramePreset = keyof typeof FRAME_PRESETS;

/** The frame of a card that names none (a live room's card, or one from before frames): it filled its card, like a window. */
export const DEFAULT_FRAME: FramePreset = "window";

/** A custom frame's bounds, in CSS px. */
export const FRAME_MIN = { w: 120, h: 24 } as const;
export const FRAME_MAX = { w: 3840, h: 2400 } as const;

/** A frame as drawn: its preset (or `custom`), the name in the card header, and its size. */
export interface Frame {
  preset: FramePreset | "custom";
  label: string;
  w: number;
  h: number;
}

export function isFramePreset(value: unknown): value is FramePreset {
  return typeof value === "string" && Object.hasOwn(FRAME_PRESETS, value);
}

const CUSTOM = /^(\d{2,4})x(\d{2,4})$/;

/**
 * The frame a card's `data.frame` names: a preset (`page`, `phone`...) or a custom `<w>x<h>`
 * (`1200x760`, kept within FRAME_MIN and FRAME_MAX). Null for anything else.
 */
export function parseFrame(value: string | undefined): Frame | null {
  if (value === undefined) return null;
  if (isFramePreset(value)) return { preset: value, ...FRAME_PRESETS[value] };
  const m = CUSTOM.exec(value);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < FRAME_MIN.w || h < FRAME_MIN.h || w > FRAME_MAX.w || h > FRAME_MAX.h) return null;
  return { preset: "custom", label: "Custom", w, h };
}

/** A card's frame: its `data.frame`, else the default. */
export function frameOf(value: string | undefined): Frame {
  return parseFrame(value) ?? { preset: DEFAULT_FRAME, ...FRAME_PRESETS[DEFAULT_FRAME] };
}

/** The `data.frame` value of a custom size. */
export function customFrame(w: number, h: number): string {
  return `${String(Math.round(w))}x${String(Math.round(h))}`;
}

/**
 * Why `value` is not a component card's frame, with the presets to pick from, or null when it is
 * one. A missing frame is refused too: a card is designed for a surface, so the agent names it.
 */
export function frameRefusal(value: string | undefined): string | null {
  if (parseFrame(value) !== null) return null;
  const presets = Object.entries(FRAME_PRESETS)
    .map(([id, f]) => `${id} (${f.label}, ${String(f.w)}x${String(f.h)})`)
    .join(", ");
  const what =
    value === undefined
      ? "a component card needs data.frame, the Relay surface it is designed for"
      : `frame "${value}" is not a preset or <w>x<h> (${String(FRAME_MIN.w)}-${String(FRAME_MAX.w)} by ${String(FRAME_MIN.h)}-${String(FRAME_MAX.h)})`;
  return `${what}; presets: ${presets}`;
}
