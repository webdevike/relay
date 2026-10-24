/**
 * Home widgets as data: which widgets the phone shows, in what order and at which size, plus the
 * pure layout math the grid draws from. No React Native imports; the settings store persists the
 * list and `WidgetGrid` animates to the rects computed here.
 *
 * Sizes follow the iOS home screen: `small` is a square half the row wide (2x2), `medium` spans the
 * row at the same height (4x2), `large` spans the row at two smalls' height plus the gap (4x4).
 * Small widgets flow two to a row in list order; a medium or large widget always takes a row of
 * its own, so a small widget right before it sits alone on the left.
 */

export const WIDGET_KINDS = ["usage", "assistants", "inbox", "boards", "apps"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WIDGET_SIZE_LIST = ["small", "medium", "large"] as const;
export type WidgetSize = (typeof WIDGET_SIZE_LIST)[number];

/** The sizes each kind can be drawn at, smallest first. */
export const WIDGET_SIZES: Record<WidgetKind, readonly WidgetSize[]> = {
  usage: ["small", "medium"],
  assistants: ["small", "medium"],
  inbox: ["small", "medium"],
  boards: ["small"],
  apps: ["medium", "large"],
};

export interface HomeWidget {
  /** Stable per placement: the same kind can sit on Home twice. */
  id: string;
  kind: WidgetKind;
  size: WidgetSize;
}

/** What Home shows before the user has arranged anything. */
export const DEFAULT_WIDGETS: readonly HomeWidget[] = [
  { id: "usage-1", kind: "usage", size: "medium" },
  { id: "assistants-1", kind: "assistants", size: "small" },
  { id: "inbox-1", kind: "inbox", size: "small" },
  { id: "apps-1", kind: "apps", size: "large" },
];

function isKind(value: unknown): value is WidgetKind {
  return typeof value === "string" && (WIDGET_KINDS as readonly string[]).includes(value);
}

function supports(kind: WidgetKind, size: unknown): size is WidgetSize {
  return typeof size === "string" && (WIDGET_SIZES[kind] as readonly string[]).includes(size);
}

/**
 * A stored widget list from any build. Nothing stored (an older build) is the default layout; an
 * empty list stays empty because the user removed everything. Unknown kinds and duplicate ids are
 * dropped; a size the kind no longer offers falls back to its smallest.
 */
export function normalizeWidgets(value: unknown): HomeWidget[] {
  if (!Array.isArray(value)) return DEFAULT_WIDGETS.map((w) => ({ ...w }));
  const seen = new Set<string>();
  const widgets: HomeWidget[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, kind, size } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || seen.has(id) || !isKind(kind)) continue;
    seen.add(id);
    widgets.push({
      id,
      kind,
      size: supports(kind, size) ? size : (WIDGET_SIZES[kind][0] ?? "small"),
    });
  }
  return widgets;
}

/**
 * Home's app list became the `apps` widget (settings v3): a layout saved before then gets one at
 * the end, large, so the list stays on Home. Called once by the settings migration, so a user who
 * removes it later keeps it removed.
 */
export function withAppsWidget(widgets: readonly HomeWidget[]): HomeWidget[] {
  if (widgets.some((w) => w.kind === "apps")) return [...widgets];
  return [...widgets, { id: nextWidgetId(widgets, "apps"), kind: "apps", size: "large" }];
}

/** `<kind>-<n>` with the lowest n no widget in `widgets` uses. */
export function nextWidgetId(widgets: readonly HomeWidget[], kind: WidgetKind): string {
  const taken = new Set(widgets.map((w) => w.id));
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

/** Appends a `kind` widget; an unsupported size becomes the kind's smallest. */
export function addWidget(
  widgets: readonly HomeWidget[],
  kind: WidgetKind,
  size: WidgetSize,
): HomeWidget[] {
  const fitted = supports(kind, size) ? size : (WIDGET_SIZES[kind][0] ?? "small");
  return [...widgets, { id: nextWidgetId(widgets, kind), kind, size: fitted }];
}

export function removeWidget(widgets: readonly HomeWidget[], id: string): HomeWidget[] {
  return widgets.filter((w) => w.id !== id);
}

/** Sets a widget's size; a size its kind does not offer leaves the list as it was. */
export function resizeWidget(
  widgets: readonly HomeWidget[],
  id: string,
  size: WidgetSize,
): HomeWidget[] {
  return widgets.map((w) => (w.id === id && supports(w.kind, size) ? { ...w, size } : w));
}

/** Moves `id` to `toIndex` (clamped), shifting the others; an unknown id changes nothing. */
export function moveWidget(
  widgets: readonly HomeWidget[],
  id: string,
  toIndex: number,
): HomeWidget[] {
  const from = widgets.findIndex((w) => w.id === id);
  if (from === -1) return [...widgets];
  const next = widgets.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...widgets];
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);
  return next;
}

/** One step earlier (`-1`) or later (`1`): the VoiceOver stand-in for dragging. */
export function shiftWidget(
  widgets: readonly HomeWidget[],
  id: string,
  delta: -1 | 1,
): HomeWidget[] {
  const from = widgets.findIndex((w) => w.id === id);
  return from === -1 ? [...widgets] : moveWidget(widgets, id, from + delta);
}

/** Rows as the grid flows them: a medium or large alone, else one or two smalls. */
export function flowRows(widgets: readonly HomeWidget[]): HomeWidget[][] {
  const rows: HomeWidget[][] = [];
  let open: HomeWidget[] | null = null;
  for (const widget of widgets) {
    if (widget.size !== "small") {
      rows.push([widget]);
      open = null;
    } else if (open === null) {
      open = [widget];
      rows.push(open);
    } else {
      open.push(widget);
      open = null;
    }
  }
  return rows;
}

export interface WidgetSlot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Space between widgets, across and down, on Home and in the gallery's previews. */
export const WIDGET_GAP = 16;

export interface GridMetrics {
  /** Width of the grid, edge to edge of the widgets. */
  width: number;
  /** Space between two widgets in a row, and between rows. */
  gap: number;
}

/** Side of a small widget, which is also a medium's height. */
export function smallSide(metrics: GridMetrics): number {
  return Math.max(0, (metrics.width - metrics.gap) / 2);
}

/** A widget's width and height at `size` in a grid of `metrics`. */
export function widgetBox(size: WidgetSize, metrics: GridMetrics): { width: number; height: number } {
  const side = smallSide(metrics);
  switch (size) {
    case "small":
      return { width: side, height: side };
    case "medium":
      return { width: metrics.width, height: side };
    case "large":
      return { width: metrics.width, height: side * 2 + metrics.gap };
  }
}

/** Where each widget goes, and how tall the grid is. A row is as tall as its tallest widget. */
export function layoutSlots(
  widgets: readonly HomeWidget[],
  metrics: GridMetrics,
): { slots: WidgetSlot[]; height: number } {
  const side = smallSide(metrics);
  const slots: WidgetSlot[] = [];
  let y = 0;
  let height = 0;
  for (const row of flowRows(widgets)) {
    let rowHeight = 0;
    row.forEach((widget, c) => {
      const box = widgetBox(widget.size, metrics);
      slots.push({ id: widget.id, x: c * (side + metrics.gap), y, ...box });
      rowHeight = Math.max(rowHeight, box.height);
    });
    height = y + rowHeight;
    y = height + metrics.gap;
  }
  return { slots, height };
}

/** The slot under a point, other than `exclude` (the one being dragged); null over a gap. Runs on the UI thread. */
export function slotAt(
  slots: readonly WidgetSlot[],
  x: number,
  y: number,
  exclude: string,
): string | null {
  "worklet";
  for (const slot of slots) {
    if (slot.id === exclude) continue;
    if (x >= slot.x && x <= slot.x + slot.width && y >= slot.y && y <= slot.y + slot.height)
      return slot.id;
  }
  return null;
}
