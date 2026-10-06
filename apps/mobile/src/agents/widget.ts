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

/** A media source: a host drop path (`/drops/<id>/<token>`, fetched from the connected host) or an
 * absolute http(s) URL. Anything else (local file paths, data URIs) is rejected. */
const MediaSrc = z.string().refine((s) => /^\/drops\/[^/]+\/[^/]+$/.test(s) || /^https?:\/\//.test(s));

const CompareSide = z.object({
  src: MediaSrc,
  label: z.string().optional(),
});

/** Before/after slider: both images share one frame; dragging the divider reveals more of either. */
const Compare = z.object({
  widget: z.literal("compare"),
  title: z.string().optional(),
  before: CompareSide,
  after: CompareSide,
});

/** Inline audio player: play/pause, a seekable progress bar, elapsed/total time. */
const Audio = z.object({
  widget: z.literal("audio"),
  title: z.string().optional(),
  src: MediaSrc,
});

/** One gallery image. `url` (http(s) only) is the source page, e.g. the Dribbble shot. */
const GalleryImage = z.object({
  src: MediaSrc,
  title: z.string().optional(),
  caption: z.string().optional(),
  url: z.string().url().refine((u) => /^https?:\/\//.test(u)).optional().catch(undefined),
});

/** Image carousel: swipe or chevrons inline; tap opens a full-screen pager with pinch zoom. */
const Gallery = z.object({
  widget: z.literal("gallery"),
  title: z.string().optional(),
  images: z.array(GalleryImage).min(1).max(50),
});

/** A line of text. `style` picks the type scale; an unknown style degrades to body. */
const TextNode = z.object({
  widget: z.literal("text"),
  text: z.string().min(1),
  style: z.enum(["heading", "body", "caption", "muted"]).optional().catch(undefined),
});

/** Tones shared by badges and row values; an unknown tone degrades to neutral. */
const Tone = z.enum(["accent", "ok", "warn", "danger", "muted"]).optional().catch(undefined);

/** Label/value pairs on hairline dividers: summaries, checks, key facts. */
const Rows = z.object({
  widget: z.literal("rows"),
  rows: z.array(z.object({ label: z.string(), value: z.string(), tone: Tone })).min(1),
});

const Badge = z.object({
  widget: z.literal("badge"),
  label: z.string().min(1),
  tone: Tone,
});

const Divider = z.object({ widget: z.literal("divider") });

/** A unified diff (`git diff` output, one file) rendered with line numbers and tinted rows. */
const Diff = z.object({
  widget: z.literal("diff"),
  file: z.string().optional(),
  patch: z.string().min(1).max(50_000),
});

/** One message row. `url` (http(s) only, e.g. the Gmail thread link) makes the row open it. */
const Email = z.object({
  from: z.string(),
  subject: z.string(),
  snippet: z.string().optional(),
  date: z.string().optional(),
  unread: z.boolean().optional(),
  url: z.string().url().refine((u) => /^https?:\/\//.test(u)).optional().catch(undefined),
});

/** An inbox list: sender, subject, snippet, time, unread dot; flat rows on hairlines. */
const Emails = z.object({
  widget: z.literal("emails"),
  title: z.string().optional(),
  emails: z.array(Email).min(1).max(50),
});

/** Most children a container takes and deepest containers nest; past either, the whole spec
 * falls back to code rather than rendering something unbounded. */
export const MAX_CHILDREN = 24;
export const MAX_DEPTH = 4;

type Leaf =
  | z.infer<typeof Chart>
  | z.infer<typeof Stat>
  | z.infer<typeof Tickets>
  | z.infer<typeof Compare>
  | z.infer<typeof Audio>
  | z.infer<typeof Gallery>
  | z.infer<typeof TextNode>
  | z.infer<typeof Rows>
  | z.infer<typeof Badge>
  | z.infer<typeof Divider>
  | z.infer<typeof Diff>
  | z.infer<typeof Emails>;

/** Lays children out in a column (default) or a row of equal-width columns. */
export interface StackSpec {
  widget: "stack";
  direction?: "vertical" | "horizontal" | undefined;
  gap?: "xs" | "sm" | "md" | "lg" | undefined;
  children: WidgetSpec[];
}

/** Groups children inside a hairline border, with an optional heading. */
export interface CardSpec {
  widget: "card";
  title?: string | undefined;
  children: WidgetSpec[];
}

export type WidgetSpec = Leaf | StackSpec | CardSpec;

// Input is `unknown`: the `.catch` fields accept shapes the output type doesn't.
const Children: z.ZodType<WidgetSpec[], z.ZodTypeDef, unknown> = z.lazy(() => z.array(Node).min(1).max(MAX_CHILDREN));

const Stack = z.object({
  widget: z.literal("stack"),
  direction: z.enum(["vertical", "horizontal"]).optional().catch(undefined),
  gap: z.enum(["xs", "sm", "md", "lg"]).optional().catch(undefined),
  children: Children,
});

const Card = z.object({
  widget: z.literal("card"),
  title: z.string().optional(),
  children: Children,
});

const Node: z.ZodType<WidgetSpec, z.ZodTypeDef, unknown> = z.discriminatedUnion("widget", [
  Chart,
  Stat,
  Tickets,
  Compare,
  Audio,
  Gallery,
  TextNode,
  Rows,
  Badge,
  Divider,
  Diff,
  Emails,
  Stack,
  Card,
]);

export type Series = z.infer<typeof Series>;
export type ChartSpec = z.infer<typeof Chart>;
export type StatSpec = z.infer<typeof Stat>;
export type TicketSpec = z.infer<typeof Ticket>;
export type TicketsSpec = z.infer<typeof Tickets>;
export type CompareSpec = z.infer<typeof Compare>;
export type AudioSpec = z.infer<typeof Audio>;
export type GallerySpec = z.infer<typeof Gallery>;
export type TextSpec = z.infer<typeof TextNode>;
export type RowsSpec = z.infer<typeof Rows>;
export type BadgeSpec = z.infer<typeof Badge>;
export type DiffSpec = z.infer<typeof Diff>;
export type EmailSpec = z.infer<typeof Email>;
export type EmailsSpec = z.infer<typeof Emails>;
export type Tone = NonNullable<z.infer<typeof Tone>>;

/** Container nesting depth of raw JSON, checked before zod so a hostile spec can't recurse deep. */
function containerDepth(node: unknown, limit: number): number {
  if (typeof node !== "object" || node === null || !("children" in node) || !Array.isArray(node.children)) return 0;
  const children: unknown[] = node.children;
  if (limit <= 0) return 1;
  let deepest = 0;
  for (const child of children) deepest = Math.max(deepest, containerDepth(child, limit - 1));
  return 1 + deepest;
}

/** Parses and validates a ```ui payload. Returns null on any malformed field so the transcript
 * can fall back to rendering the block as literal code. */
export function parseWidget(text: string): WidgetSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (containerDepth(raw, MAX_DEPTH) > MAX_DEPTH) return null;
  const result = Node.safeParse(raw);
  return result.success ? result.data : null;
}
