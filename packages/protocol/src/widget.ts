/**
 * Generative-UI widget specs: the typed, safe payload an agent emits inside a ```ui fence or as
 * a dashboard tile. Clients render a fixed catalogue of native widgets from these specs — no
 * arbitrary code runs on the device, and rendering is deterministic and instant. Validated with
 * zod so a malformed or hostile payload is rejected (chat falls back to showing raw code).
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
  stateType: z
    .enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"])
    .optional()
    .catch(undefined),
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
const MediaSrc = z
  .string()
  .refine((s) => /^\/drops\/[^/]+\/[^/]+$/.test(s) || /^https?:\/\//.test(s));

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

/** Inline video player: a frame at the video's aspect ratio, play/pause, a seekable progress bar,
 * elapsed/total time. */
const Video = z.object({
  widget: z.literal("video"),
  title: z.string().optional(),
  src: MediaSrc,
});

/** One gallery image. `url` (http(s) only) is the source page, e.g. the Dribbble shot. */
const GalleryImage = z.object({
  src: MediaSrc,
  title: z.string().optional(),
  caption: z.string().optional(),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u))
    .optional()
    .catch(undefined),
});

/** Image carousel: swipe or chevrons inline; tap opens a full-screen pager with pinch zoom. */
const Gallery = z.object({
  widget: z.literal("gallery"),
  title: z.string().optional(),
  images: z.array(GalleryImage).min(1).max(50),
});

/** Interactive 3D model (GLB, or glTF with embedded buffers): framed to fit, one-finger drag orbits,
 * pinch zooms. `autoRotate` spins it on a turntable until touched; a bad value just leaves it still. */
const Model = z.object({
  widget: z.literal("model"),
  src: MediaSrc,
  title: z.string().optional(),
  caption: z.string().optional(),
  autoRotate: z.boolean().optional().catch(undefined),
});

/** An absolute http(s) URL, validated strictly: required links reject the spec when it's bad. */
const WebUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u));

/** An optional http(s) link that degrades to absent when it's bad, rather than rejecting. */
const HttpUrl = WebUrl.optional().catch(undefined);

/** A required string with something other than whitespace in it. */
const NonEmpty = z.string().refine((s) => s.trim().length > 0);

const RecipeIngredient = z.object({
  item: z.string().min(1),
  section: z.string().optional(),
});

/** Interactive recipe: ingredients are checkable and directions live on a separate tab. */
const Recipe = z.object({
  widget: z.literal("recipe"),
  title: z.string().min(1),
  meta: z.array(z.string().min(1)).max(4).optional(),
  ingredients: z.array(RecipeIngredient).min(1).max(50),
  directions: z.array(z.string().min(1)).min(1).max(30),
  source: HttpUrl,
});

/** A line of text. `style` picks the type scale; an unknown style degrades to body. */
const TextNode = z.object({
  widget: z.literal("text"),
  text: z.string().min(1),
  style: z.enum(["heading", "body", "caption", "muted"]).optional().catch(undefined),
});

/** Tones shared by badges and row values; an unknown tone degrades to neutral. */
const ToneName = z.enum(["accent", "ok", "warn", "danger", "muted"]);
const Tone = ToneName.optional().catch(undefined);
/** A tone that falls back to accent when missing or unknown. */
const AccentTone = ToneName.catch("accent");

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
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u))
    .optional()
    .catch(undefined),
});

/** An inbox list: sender, subject, snippet, time, unread dot; flat rows on hairlines. */
const Emails = z.object({
  widget: z.literal("emails"),
  title: z.string().optional(),
  emails: z.array(Email).min(1).max(50),
});

/** One CI run (a GitHub Actions job). An unknown status degrades to pending. */
const PrCheck = z.object({
  name: z.string(),
  status: z.enum(["success", "failure", "pending", "skipped"]).catch("pending"),
  duration: z.string().optional(),
  url: HttpUrl,
});

/** A pull request, GitHub-mobile style: header, then Overview (markdown body + reviewers),
 * Checks, and Files (one unified diff per file) tabs. */
const Pr = z.object({
  widget: z.literal("pr"),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]).catch("open"),
  author: z.string().optional(),
  branch: z.string().optional(),
  base: z.string().optional(),
  url: HttpUrl,
  body: z.string().max(50_000).optional(),
  reviewers: z
    .array(
      z.object({
        name: z.string(),
        state: z.enum(["approved", "changes", "pending", "commented"]).catch("pending"),
      }),
    )
    .max(20)
    .optional(),
  checks: z.array(PrCheck).max(50).optional(),
  files: z
    .array(
      z.object({
        file: z.string(),
        patch: z.string().min(1).max(50_000),
        additions: z.number().int().optional(),
        deletions: z.number().int().optional(),
      }),
    )
    .max(30)
    .optional(),
});

/** A tappable action: `url` opens externally, `reply` sends text as the session's next turn.
 * Exactly one of the two (enforced in `finish`); an unknown variant degrades to secondary. */
const Button = z.object({
  widget: z.literal("button"),
  label: NonEmpty,
  url: WebUrl.optional(),
  reply: NonEmpty.optional(),
  variant: z.enum(["primary", "secondary", "subtle"]).catch("secondary"),
  tone: Tone,
});

/** Inline text link to an http(s) page. */
const Link = z.object({
  widget: z.literal("link"),
  label: NonEmpty,
  url: WebUrl,
});

/** One framed image; tap opens the full-screen viewer. `aspect` is width/height, and one outside
 * 0.25..4 falls back to the image's own shape. */
const ImageNode = z.object({
  widget: z.literal("image"),
  src: MediaSrc,
  alt: z.string().optional(),
  caption: z.string().optional(),
  url: HttpUrl,
  aspect: z.number().min(0.25).max(4).optional().catch(undefined),
});

const TableColumn = z.union([
  z.string(),
  z.object({
    label: z.string(),
    align: z.enum(["left", "right", "center"]).optional().catch(undefined),
  }),
]);

/** Brand marks a table cell can draw before its text (Simple Icons, monochrome in the text color). */
export const TABLE_CELL_ICONS = ["github", "linear"] as const;

/** A cell with `url` is a tappable link (http(s) only, like `link`); with an `icon`, `text` may be
 * empty for an icon-only cell. */
const TableCell = z.union([
  z.string(),
  z.number().finite(),
  z.object({
    text: z.string(),
    tone: Tone,
    bold: z.boolean().optional(),
    url: WebUrl.optional(),
    icon: z.enum(TABLE_CELL_ICONS).optional(),
  }),
]);

/** A data table. Every row has exactly one cell per column (enforced in `finish`). */
const Table = z.object({
  widget: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(TableColumn).min(1).max(8),
  rows: z.array(z.array(TableCell)).min(1).max(100),
});

/** A labelled bar. A bad `max` degrades to 100; `value` is clamped into 0..max in `finish`. */
const Progress = z.object({
  widget: z.literal("progress"),
  value: z.number().finite(),
  max: z.number().finite().positive().catch(100),
  label: z.string().optional(),
  caption: z.string().optional(),
  tone: AccentTone,
});

const ListItem = z.union([
  z.string(),
  z.object({ text: NonEmpty, caption: z.string().optional(), checked: z.boolean().optional() }),
]);

/** Bulleted, numbered, or static checklist; an unknown style degrades to bullets. */
const List = z.object({
  widget: z.literal("list"),
  style: z.enum(["bullet", "number", "check"]).catch("bullet"),
  items: z.array(ListItem).min(1).max(50),
});

/** A tinted note with a tone icon. */
const Callout = z.object({
  widget: z.literal("callout"),
  text: NonEmpty,
  title: z.string().optional(),
  tone: AccentTone,
});

/** A syntax-highlighted code block with an optional title. */
const Code = z.object({
  widget: z.literal("code"),
  code: z
    .string()
    .max(50_000)
    .refine((s) => s.trim().length > 0),
  language: z.string().optional(),
  title: z.string().optional(),
});

const Quote = z.object({
  widget: z.literal("quote"),
  text: NonEmpty,
  cite: z.string().optional(),
});

/** A person: photo (or initials when there's none or it's not a valid source), name, subtitle. */
const Avatar = z.object({
  widget: z.literal("avatar"),
  name: NonEmpty,
  subtitle: z.string().optional(),
  src: MediaSrc.optional().catch(undefined),
});

const TimelineEntry = z.object({
  title: NonEmpty,
  time: z.string().optional(),
  text: z.string().optional(),
  tone: Tone,
});

const Timeline = z.object({
  widget: z.literal("timeline"),
  items: z.array(TimelineEntry).min(1).max(30),
});

/** A text field whose submit sends `reply` with `{value}` replaced by the typed text. */
const Input = z.object({
  widget: z.literal("input"),
  placeholder: z.string().optional(),
  button: z.string().default("Send"),
  reply: z
    .string()
    .refine((s) => s.includes("{value}"))
    .default("{value}"),
  multiline: z.boolean().optional(),
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
  | z.infer<typeof Video>
  | z.infer<typeof Gallery>
  | z.infer<typeof Model>
  | z.infer<typeof Recipe>
  | z.infer<typeof TextNode>
  | z.infer<typeof Rows>
  | z.infer<typeof Badge>
  | z.infer<typeof Divider>
  | z.infer<typeof Diff>
  | z.infer<typeof Emails>
  | z.infer<typeof Pr>
  | z.infer<typeof Button>
  | z.infer<typeof Link>
  | z.infer<typeof ImageNode>
  | z.infer<typeof Table>
  | z.infer<typeof Progress>
  | z.infer<typeof List>
  | z.infer<typeof Callout>
  | z.infer<typeof Code>
  | z.infer<typeof Quote>
  | z.infer<typeof Avatar>
  | z.infer<typeof Timeline>
  | z.infer<typeof Input>

const Gap = z.enum(["xs", "sm", "md", "lg"]);
export type Gap = z.infer<typeof Gap>;

/** Lays children out in a column (default) or a row of equal-width columns. */
export interface StackSpec {
  widget: "stack";
  direction?: "vertical" | "horizontal" | undefined;
  gap?: Gap | undefined;
  children: WidgetSpec[];
}

/** Groups children inside a hairline border, with an optional heading. */
export interface CardSpec {
  widget: "card";
  title?: string | undefined;
  children: WidgetSpec[];
}

/** Wraps children into rows of `columns` equal cells. */
export interface GridSpec {
  widget: "grid";
  columns: 2 | 3 | 4;
  gap?: Gap | undefined;
  children: WidgetSpec[];
}

/** A tab bar over one visible pane per tab. */
export interface TabsSpec {
  widget: "tabs";
  tabs: { label: string; children: WidgetSpec[] }[];
}

/** A header row that shows or hides its children. */
export interface CollapseSpec {
  widget: "collapse";
  title: string;
  open: boolean;
  children: WidgetSpec[];
}

export type WidgetSpec = Leaf | StackSpec | CardSpec | GridSpec | TabsSpec | CollapseSpec;

// Input is `unknown`: the `.catch` fields accept shapes the output type doesn't.
const Children: z.ZodType<WidgetSpec[], z.ZodTypeDef, unknown> = z.lazy(() =>
  z.array(Node).min(1).max(MAX_CHILDREN),
);

const Stack = z.object({
  widget: z.literal("stack"),
  direction: z.enum(["vertical", "horizontal"]).optional().catch(undefined),
  gap: Gap.optional().catch(undefined),
  children: Children,
});

const Card = z.object({
  widget: z.literal("card"),
  title: z.string().optional(),
  children: Children,
});

const Grid = z.object({
  widget: z.literal("grid"),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).catch(2),
  gap: Gap.optional().catch(undefined),
  children: Children,
});

const Tabs = z.object({
  widget: z.literal("tabs"),
  tabs: z
    .array(z.object({ label: NonEmpty, children: Children }))
    .min(2)
    .max(6),
});

const Collapse = z.object({
  widget: z.literal("collapse"),
  title: NonEmpty,
  open: z.boolean().default(false),
  children: Children,
});

const Node: z.ZodType<WidgetSpec, z.ZodTypeDef, unknown> = z
  .discriminatedUnion("widget", [
    Chart,
    Stat,
    Tickets,
    Compare,
    Audio,
    Video,
    Gallery,
    Model,
    Recipe,
    TextNode,
    Rows,
    Badge,
    Divider,
    Diff,
    Emails,
    Pr,
    Button,
    Link,
    ImageNode,
    Table,
    Progress,
    List,
    Callout,
    Code,
    Quote,
    Avatar,
    Timeline,
    Input,
    Stack,
    Card,
    Grid,
    Tabs,
    Collapse,
  ])
  .transform(finish);

/** Rules spanning several fields, which zod's discriminated union members can't carry themselves. */
function finish(node: WidgetSpec, ctx: z.RefinementCtx): WidgetSpec {
  const reject = (message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    return z.NEVER;
  };
  if (node.widget === "button" && (node.url === undefined) === (node.reply === undefined))
    return reject("a button needs exactly one of url or reply");
  if (node.widget === "table" && node.rows.some((row) => row.length !== node.columns.length))
    return reject("every table row needs one cell per column");
  if (node.widget === "progress")
    return { ...node, value: Math.min(Math.max(node.value, 0), node.max) };
  return node;
}

export type Series = z.infer<typeof Series>;
export type ChartSpec = z.infer<typeof Chart>;
export type StatSpec = z.infer<typeof Stat>;
export type TicketSpec = z.infer<typeof Ticket>;
export type TicketsSpec = z.infer<typeof Tickets>;
export type CompareSpec = z.infer<typeof Compare>;
export type AudioSpec = z.infer<typeof Audio>;
export type VideoSpec = z.infer<typeof Video>;
export type GallerySpec = z.infer<typeof Gallery>;
export type ModelSpec = z.infer<typeof Model>;
export type RecipeIngredient = z.infer<typeof RecipeIngredient>;
export type RecipeSpec = z.infer<typeof Recipe>;
export type TextSpec = z.infer<typeof TextNode>;
export type RowsSpec = z.infer<typeof Rows>;
export type BadgeSpec = z.infer<typeof Badge>;
export type DiffSpec = z.infer<typeof Diff>;
export type EmailSpec = z.infer<typeof Email>;
export type EmailsSpec = z.infer<typeof Emails>;
export type PrSpec = z.infer<typeof Pr>;
export type ButtonSpec = z.infer<typeof Button>;
export type LinkSpec = z.infer<typeof Link>;
export type ImageSpec = z.infer<typeof ImageNode>;
export type TableColumn = z.infer<typeof TableColumn>;
export type TableCell = z.infer<typeof TableCell>;
export type TableCellIcon = (typeof TABLE_CELL_ICONS)[number];
export type TableSpec = z.infer<typeof Table>;
export type ProgressSpec = z.infer<typeof Progress>;
export type ListItem = z.infer<typeof ListItem>;
export type ListSpec = z.infer<typeof List>;
export type CalloutSpec = z.infer<typeof Callout>;
export type CodeSpec = z.infer<typeof Code>;
export type QuoteSpec = z.infer<typeof Quote>;
export type AvatarSpec = z.infer<typeof Avatar>;
export type TimelineEntry = z.infer<typeof TimelineEntry>;
export type TimelineSpec = z.infer<typeof Timeline>;
export type InputSpec = z.infer<typeof Input>;
export type Tone = NonNullable<z.infer<typeof Tone>>;

/** A widget tree as an embeddable schema: container depth is checked before zod descends. */
export const WidgetNode = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (containerDepth(raw, MAX_DEPTH) > MAX_DEPTH)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `containers nest deeper than ${MAX_DEPTH}`,
      });
  })
  .pipe(Node);

/** Container nesting depth of raw JSON, checked before zod so a hostile spec can't recurse deep. */
function containerDepth(node: unknown, limit: number): number {
  const children = childLists(node);
  if (children === null) return 0;
  if (limit <= 0) return 1;
  let deepest = 0;
  for (const child of children) deepest = Math.max(deepest, containerDepth(child, limit - 1));
  return 1 + deepest;
}

/** A raw node's children, or null for a leaf. A `tabs` node is one container level: every tab's
 * children sit one level below it. */
function childLists(node: unknown): unknown[] | null {
  if (typeof node !== "object" || node === null) return null;
  if ("children" in node && Array.isArray(node.children)) {
    const children: unknown[] = node.children;
    return children;
  }
  if ("tabs" in node && Array.isArray(node.tabs)) {
    const tabs: unknown[] = node.tabs;
    return tabs.flatMap((tab): unknown[] =>
      typeof tab === "object" && tab !== null && "children" in tab && Array.isArray(tab.children)
        ? (tab.children as unknown[])
        : [],
    );
  }
  return null;
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
  const result = WidgetNode.safeParse(raw);
  return result.success ? result.data : null;
}
