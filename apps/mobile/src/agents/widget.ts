/**
 * Generative-UI widget specs: the typed, safe payload an agent emits inside a ```ui fence.
 * The phone renders a fixed catalogue of native widgets from these specs — no arbitrary code
 * runs on the device, and rendering is deterministic and instant. Validated with zod so a
 * malformed or hostile payload becomes null (the caller falls back to showing raw code).
 */
import { z } from "zod";

const Series = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
  points: z.array(z.number().finite()).min(1),
});

const Chart = z.object({
  widget: z.literal("chart"),
  kind: z.enum(["bar", "line"]),
  stacked: z.boolean().optional(),
  title: z.string().optional(),
  labels: z.array(z.string()).optional(),
  series: z.array(Series).min(1),
});

const Stat = z.object({
  widget: z.literal("stat"),
  label: z.string(),
  value: z.string(),
  delta: z
    .object({
      value: z.string(),
      direction: z.enum(["up", "down", "flat"]).catch("flat"),
    })
    .optional(),
});

/** One ticket card. `stateType` mirrors Linear's workflow-state type and only picks the pill tone;
 * an unknown value degrades to neutral rather than rejecting the whole carousel. */
const Ticket = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  state: z.string().optional(),
  stateType: z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"]).optional().catch(undefined),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  updated: z.string().optional(),
  url: z.string().url().optional().catch(undefined),
});

const Tickets = z.object({
  widget: z.literal("tickets"),
  title: z.string().optional(),
  tickets: z.array(Ticket).min(1),
});

/** An image source: a host drop path (`/drops/<id>/<token>`, fetched from the connected host) or an
 * absolute http(s) URL. Anything else (local file paths, data URIs) is rejected. */
const ImageSrc = z.string().refine((s) => /^\/drops\/[^/]+\/[^/]+$/.test(s) || /^https?:\/\//.test(s));

const CompareSide = z.object({
  src: ImageSrc,
  label: z.string().optional(),
});

/** Before/after slider: both images share one frame; dragging the divider reveals more of either. */
const Compare = z.object({
  widget: z.literal("compare"),
  title: z.string().optional(),
  before: CompareSide,
  after: CompareSide,
});

const Widget = z.discriminatedUnion("widget", [Chart, Stat, Tickets, Compare]);

export type Series = z.infer<typeof Series>;
export type ChartSpec = z.infer<typeof Chart>;
export type StatSpec = z.infer<typeof Stat>;
export type TicketSpec = z.infer<typeof Ticket>;
export type TicketsSpec = z.infer<typeof Tickets>;
export type CompareSpec = z.infer<typeof Compare>;
export type WidgetSpec = z.infer<typeof Widget>;

/** Parses and validates a ```ui payload. Returns null on any malformed field so the transcript
 * can fall back to rendering the block as literal code. */
export function parseWidget(text: string): WidgetSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = Widget.safeParse(raw);
  return result.success ? result.data : null;
}
