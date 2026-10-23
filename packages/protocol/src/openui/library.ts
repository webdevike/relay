/**
 * The Relay widget catalogue as an OpenUI Lang component library: one component per `WidgetNode`
 * type in `../widget.ts` (PascalCase of its `widget` key), plus sub-components for the structured
 * items those widgets hold (a chart's series, a ticket, a table cell, a tab, ...). Props map 1:1 to
 * the JSON fields; positional order is required fields first, then optional ones by usefulness.
 * These zod v4 schemas only drive the parser's positional mapping and the generated prompt; the
 * converted tree is validated by the real `WidgetNode` schema.
 */
import { z } from "zod/v4";
import type { WidgetSpec } from "../widget";
import { createLibrary, defineComponent, tagSchemaId, type DefinedComponent } from "./lang/library";
import { action } from "./lang/parser/builtins";
import { markReactive } from "./lang/reactive";

type WidgetKind = WidgetSpec["widget"];

const tone = z.enum(["accent", "ok", "warn", "danger", "muted"]);
const gap = z.enum(["xs", "sm", "md", "lg"]);

/** Any widget component; the element type of every container's `children`. */
const Child = z.lazy(() => z.union(WIDGETS.map((w) => w.ref)));
tagSchemaId(Child, "Component");
const children = z.array(Child);

/** A prop taking a `$variable` for two-way binding (`$binding<string>` in the prompt). */
const bound = z.string().optional();
markReactive(bound);

function sub(name: string, props: z.ZodObject, description: string): DefinedComponent {
  return defineComponent({ name, props, description, component: null });
}

// ─── Sub-components (items inside a widget, never children of a container) ────────────────────

const Series = sub(
  "Series",
  z.object({ points: z.array(z.number()), name: z.string().optional(), color: z.string().optional() }),
  "One chart series. color: hex like \"#A7F3D0\"; omit for the default palette.",
);
const Delta = sub(
  "Delta",
  z.object({ value: z.string(), direction: z.enum(["up", "down", "flat"]).optional() }),
  "A stat's change: up is green, down red, flat (default) grey.",
);
const Ticket = sub(
  "Ticket",
  z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    url: z.string().optional(),
    state: z.string().optional(),
    stateType: z
      .enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"])
      .optional(),
    priority: z.string().optional(),
    assignee: z.string().optional(),
    updated: z.string().optional(),
  }),
  "One ticket card. summary: 1-3 sentences you wrote (what it is, where it stands, what's next), not the raw description. url: the issue's canonical link copied verbatim (never built by hand). stateType (Linear's workflow-state type) colors the state pill.",
);
const Side = sub(
  "Side",
  z.object({ src: z.string(), label: z.string().optional() }),
  'One side of a Compare. src: host drop path "/drops/<id>/<token>" or https URL. label: corner tag (default "Before"/"After").',
);
const GalleryImage = sub(
  "GalleryImage",
  z.object({
    src: z.string(),
    title: z.string().optional(),
    caption: z.string().optional(),
    url: z.string().optional(),
  }),
  "One gallery page. src: drop path or https URL; url: the source page (http(s)).",
);
const Ingredient = sub(
  "Ingredient",
  z.object({ item: z.string(), section: z.string().optional() }),
  "One recipe ingredient. Set section only where a new group starts.",
);
const Row = sub(
  "Row",
  z.object({ label: z.string(), value: z.string(), tone: tone.optional() }),
  "One label/value row; tone colors the value.",
);
const Email = sub(
  "Email",
  z.object({
    from: z.string(),
    subject: z.string(),
    snippet: z.string().optional(),
    date: z.string().optional(),
    unread: z.boolean().optional(),
    url: z.string().optional(),
  }),
  "One inbox row; url (http(s), e.g. the Gmail thread) makes it open.",
);
const Reviewer = sub(
  "Reviewer",
  z.object({ name: z.string(), state: z.enum(["approved", "changes", "pending", "commented"]).optional() }),
  "A PR reviewer; state defaults to pending.",
);
const PrCheck = sub(
  "PrCheck",
  z.object({
    name: z.string(),
    status: z.enum(["success", "failure", "pending", "skipped"]).optional(),
    duration: z.string().optional(),
    url: z.string().optional(),
  }),
  "One CI run; status defaults to pending.",
);
const PrFile = sub(
  "PrFile",
  z.object({
    file: z.string(),
    patch: z.string(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
  }),
  "One changed file of a PR: its unified diff.",
);
const Column = sub(
  "Column",
  z.object({ label: z.string(), align: z.enum(["left", "right", "center"]).optional() }),
  "A table column header with alignment; a plain string works when alignment doesn't matter.",
);
const Cell = sub(
  "Cell",
  z.object({
    text: z.string(),
    tone: tone.optional(),
    bold: z.boolean().optional(),
    url: z.string().optional(),
    icon: z.enum(["github", "linear"]).optional(),
  }),
  'A styled table cell. url (http(s) only) makes it a tappable link; icon draws that brand logo before text, and text may be "" for an icon-only cell.',
);
const ListItem = sub(
  "ListItem",
  z.object({ text: z.string(), caption: z.string().optional(), checked: z.boolean().optional() }),
  "A list item with a caption or check state; a plain string works otherwise. Checked items mute and strike through.",
);
const TimelineEntry = sub(
  "TimelineEntry",
  z.object({
    title: z.string(),
    time: z.string().optional(),
    text: z.string().optional(),
    tone: tone.optional(),
  }),
  "One timeline event.",
);
const Tab = sub(
  "Tab",
  z.object({ label: z.string(), children }),
  "One tab of Tabs: its label and the widgets in its pane.",
);

// ─── Widgets ──────────────────────────────────────────────────────────────────────────────────

/** Every widget's props and prompt description, keyed by its `widget` key (exhaustive by type). */
const WIDGET_DEFS: Record<WidgetKind, [props: z.ZodObject, description: string]> = {
  // Layout
  card: [
    z.object({ children, title: z.string().optional() }),
    "Groups children inside a hairline border with an optional heading. A root Card is the widget's frame; don't nest cards for decoration.",
  ],
  stack: [
    z.object({
      children,
      direction: z.enum(["vertical", "horizontal"]).optional(),
      gap: gap.optional(),
    }),
    'Lays children out in a column (default) or, with "horizontal", a row of equal-width columns. gap defaults to "sm".',
  ],
  grid: [
    z.object({
      children,
      columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
      gap: gap.optional(),
    }),
    "Wraps children into rows of `columns` equal cells (default 2). Phones may drop columns when cells get narrow.",
  ],
  tabs: [
    z.object({ tabs: z.array(Tab.ref) }),
    "A tab bar over one pane per tab (2-6 tabs); the first shows by default.",
  ],
  collapse: [
    z.object({ title: z.string(), children, open: z.boolean().optional() }),
    "A header row that shows or hides its children; open defaults to false.",
  ],
  // Small blocks
  text: [
    z.object({
      text: z.string(),
      style: z.enum(["heading", "body", "caption", "muted"]).optional(),
    }),
    "A line of text; style picks the type scale (default body).",
  ],
  rows: [
    z.object({ rows: z.array(Row.ref) }),
    "Label left, value right, hairlines between: summaries, checks, key facts.",
  ],
  badge: [
    z.object({ label: z.string(), tone: tone.optional() }),
    "A small pill. Put several in a horizontal Stack with gap \"xs\".",
  ],
  divider: [z.object({}), "A hairline."],
  callout: [
    z.object({ text: z.string(), title: z.string().optional(), tone: tone.optional() }),
    "A tinted note; tone (default accent) picks the icon.",
  ],
  quote: [
    z.object({ text: z.string(), cite: z.string().optional() }),
    "A block quote with optional attribution.",
  ],
  list: [
    z.object({
      items: z.array(z.union([z.string(), ListItem.ref])),
      style: z.enum(["bullet", "number", "check"]).optional(),
    }),
    "Bulleted (default), numbered, or static checklist of 1-50 items.",
  ],
  progress: [
    z.object({
      value: z.number(),
      max: z.number().optional(),
      label: z.string().optional(),
      caption: z.string().optional(),
      tone: tone.optional(),
    }),
    "A labelled bar showing a rounded percent; max defaults to 100, value clamps into 0..max, tone defaults to accent.",
  ],
  avatar: [
    z.object({ name: z.string(), subtitle: z.string().optional(), src: z.string().optional() }),
    "A person: photo (drop path or https; initials without one), name, subtitle.",
  ],
  timeline: [
    z.object({ items: z.array(TimelineEntry.ref) }),
    "A vertical timeline of 1-30 events.",
  ],
  code: [
    z.object({ code: z.string(), language: z.string().optional(), title: z.string().optional() }),
    "A syntax-highlighted code block (up to 50k chars).",
  ],
  diff: [
    z.object({ patch: z.string(), file: z.string().optional() }),
    "One file's unified diff (`git diff -- <file>` output as-is, up to 50k chars); file's extension picks syntax colors. Use one Diff per file in a Stack for a multi-file change.",
  ],
  // Actions
  button: [
    z.object({
      label: z.string(),
      action: action().optional(),
      url: z.string().optional(),
      variant: z.enum(["primary", "secondary", "subtle"]).optional(),
      tone: tone.optional(),
    }),
    'A tappable action. action: @ToAssistant("text") sends text as Isaac\'s next turn in this session; @OpenUrl("https://...") opens a link (url is the same as @OpenUrl); @Set/@Reset change $variables on the device, no turn sent. With no action, tapping sends the label. variant defaults to secondary. Put several in a horizontal Stack.',
  ],
  link: [
    z.object({ label: z.string(), url: z.string() }),
    "An inline text link to an http(s) page.",
  ],
  input: [
    z.object({
      placeholder: z.string().optional(),
      button: z.string().optional(),
      reply: z.string().optional(),
      multiline: z.boolean().optional(),
      value: bound,
    }),
    'A text field. Submitting sends reply with {value} replaced by the typed text (reply must contain "{value}", default "{value}"); button defaults to "Send". value: a $variable the typed text is kept in, for other widgets to read.',
  ],
  // Data
  stat: [
    z.object({ label: z.string(), value: z.string(), delta: z.optional(Delta.ref) }),
    'A headline metric. value is preformatted ("$7.9k", "1,357", "92%").',
  ],
  chart: [
    z.object({
      kind: z.enum(["bar", "line"]),
      series: z.array(Series.ref),
      labels: z.array(z.string()).optional(),
      title: z.string().optional(),
      stacked: z.boolean().optional(),
    }),
    "A bar or line chart. labels: x-axis labels, one per point. Several series draw grouped bars or overlaid lines with a legend; stacked (bar only) stacks them.",
  ],
  table: [
    z.object({
      columns: z.array(z.union([z.string(), Column.ref])),
      rows: z.array(z.array(z.union([z.string(), z.number(), Cell.ref]))),
      title: z.string().optional(),
    }),
    "A data table: 1-8 columns, 1-100 rows, every row exactly one cell per column. Scrolls sideways when wide; one link per cell.",
  ],
  tickets: [
    z.object({ tickets: z.array(Ticket.ref), title: z.string().optional() }),
    "A paged carousel, one ticket per card (Linear issues, PRs).",
  ],
  emails: [
    z.object({ emails: z.array(Email.ref), title: z.string().optional() }),
    "An inbox list of 1-50 rows: unread dot, sender, time, subject, snippet.",
  ],
  pr: [
    z.object({
      repo: z.string(),
      number: z.number(),
      title: z.string(),
      state: z.enum(["open", "draft", "merged", "closed"]).optional(),
      url: z.string().optional(),
      author: z.string().optional(),
      branch: z.string().optional(),
      base: z.string().optional(),
      body: z.string().optional(),
      reviewers: z.array(Reviewer.ref).optional(),
      checks: z.array(PrCheck.ref).optional(),
      files: z.array(PrFile.ref).optional(),
    }),
    'A pull request, GitHub-mobile style: header, then Overview (markdown body + reviewers), Checks, and Files tabs. repo is "owner/name"; state defaults to open.',
  ],
  recipe: [
    z.object({
      title: z.string(),
      ingredients: z.array(Ingredient.ref),
      directions: z.array(z.string()),
      meta: z.array(z.string()).optional(),
      source: z.string().optional(),
    }),
    "An interactive recipe: checkable ingredients (1-50) and 1-30 direction steps on a second tab. meta: 1-4 short facts (time, servings); source: the recipe's http(s) URL.",
  ],
  // Media
  image: [
    z.object({
      src: z.string(),
      alt: z.string().optional(),
      caption: z.string().optional(),
      url: z.string().optional(),
      aspect: z.number().optional(),
    }),
    'One framed image; tap opens a full-screen viewer. src: host drop path "/drops/<id>/<token>" or https URL. aspect: width/height 0.25-4 (default the image\'s own).',
  ],
  gallery: [
    z.object({ images: z.array(GalleryImage.ref), title: z.string().optional() }),
    "An image carousel (1-50) for references; tap opens a full-screen pager with pinch zoom.",
  ],
  compare: [
    z.object({ before: Side.ref, after: Side.ref, title: z.string().optional() }),
    "A before/after slider over two images of the same frame and size (visual proof).",
  ],
  audio: [
    z.object({ src: z.string(), title: z.string().optional() }),
    "An inline audio player (wav, m4a/aac, mp3). src: drop path or https URL.",
  ],
  video: [
    z.object({ src: z.string(), title: z.string().optional() }),
    "An inline video player. src: drop path or https URL.",
  ],
  model: [
    z.object({
      src: z.string(),
      title: z.string().optional(),
      caption: z.string().optional(),
      autoRotate: z.boolean().optional(),
    }),
    "An interactive 3D model (GLB, or glTF with embedded buffers): drag orbits, pinch zooms; autoRotate spins it until touched.",
  ],
};

/** The component name of a widget key: its PascalCase (`pr` -> `Pr`). */
const componentName = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

const WIDGETS: DefinedComponent[] = Object.entries(WIDGET_DEFS).map(([kind, [props, description]]) =>
  sub(componentName(kind), props, description),
);

const SUBS = [
  Series,
  Delta,
  Ticket,
  Side,
  GalleryImage,
  Ingredient,
  Row,
  Email,
  Reviewer,
  PrCheck,
  PrFile,
  Column,
  Cell,
  ListItem,
  TimelineEntry,
  Tab,
];

/** OpenUI component name -> `widget` key, for every widget component. */
export const WIDGET_KIND_BY_NAME: ReadonlyMap<string, WidgetKind> = new Map(
  (Object.keys(WIDGET_DEFS) as WidgetKind[]).map((kind) => [componentName(kind), kind]),
);

/** The library: every widget plus its sub-components, grouped for the prompt (each sub-component
 * right after the widgets that hold it). */
export const relayLibrary = createLibrary({
  root: "Card",
  components: [...WIDGETS, ...SUBS],
  componentGroups: [
    {
      name: "Layout",
      components: ["Card", "Stack", "Grid", "Tabs", "Tab", "Collapse"],
      notes: [
        "- Containers nest at most 4 deep and take at most 24 children (per tab); past either the whole widget falls back to code.",
      ],
    },
    {
      name: "Text blocks",
      components: ["Text", "Rows", "Row", "Badge", "Divider", "Callout", "Quote", "List", "ListItem"],
      notes: ['- tone is one of "accent" | "ok" | "warn" | "danger" | "muted".'],
    },
    {
      name: "Rich blocks",
      components: ["Progress", "Avatar", "Timeline", "TimelineEntry", "Code", "Diff"],
    },
    {
      name: "Actions",
      components: ["Button", "Link", "Input"],
      notes: ["- Buttons and inputs are disabled where there is no session (dashboards)."],
    },
    {
      name: "Data",
      components: ["Stat", "Delta", "Chart", "Series", "Table", "Column", "Cell", "Tickets", "Ticket"],
      notes: ["- Never put numbers you did not compute or were not given into a widget."],
    },
    {
      name: "Records",
      components: ["Emails", "Email", "Pr", "Reviewer", "PrCheck", "PrFile", "Recipe", "Ingredient"],
    },
    {
      name: "Media",
      components: ["Image", "Gallery", "GalleryImage", "Compare", "Side", "Audio", "Video", "Model"],
      notes: [
        '- Media src is a host drop path "/drops/<id>/<token>" (share the file first: `cd ~/Code/relay/apps/linux && bun run src/main.ts share <path>`) or an absolute https URL; local file paths are rejected.',
      ],
    },
  ],
});
