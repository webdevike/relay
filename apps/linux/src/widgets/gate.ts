// Which finished replies are worth the automatic widget pass (`service.ts`): a word and digit count, no model
// call. The widget agent only draws over structured data, and asking it after every reply showed 5 widgets in
// 1,112 live asks (2026-11-14 to 11-18), so the host asks it only when the reply carries some:
//   - numbers: measures worth comparing (currency, %, a number with a unit, or either side of "N vs N",
//     "from N to N", "N -> N");
//   - items: table rows, plus list items and "Label: ..." lines that hold a number (a list of prose
//     points is not data: 123 live asks whose only signal was such a list got no widget from the agent);
//   - keys: distinct ticket or PR keys (ENG-123, #123);
//   - media: images (markdown images, image paths or URLs), or one image with before/after wording.
// Fenced code blocks are left out of every count. The thresholds are `components.widget.autoAsk` in the
// atomic-agents config.json (`autoAskSettings` in service.ts), read on every reply.

export const WIDGET_SIGNALS = ["numbers", "items", "keys", "media"] as const;
export type WidgetSignal = (typeof WIDGET_SIGNALS)[number];

/** How many of each it takes for a reply to get the widget pass (`media` counts images). */
export type GateLimits = Readonly<Record<WidgetSignal, number>>;

export const GATE_DEFAULTS: GateLimits = { numbers: 3, items: 3, keys: 2, media: 2 };

export interface GateResult {
  readonly eligible: boolean;
  /** The signals that reached their limit, in `WIDGET_SIGNALS` order; empty when not eligible. */
  readonly signals: readonly WidgetSignal[];
  readonly counts: Readonly<Record<WidgetSignal, number>>;
  /** Before/after wording: with one image it is enough for `media`. */
  readonly beforeAfter: boolean;
}

const CODE_FENCE = /^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm;
const NUM = String.raw`(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?`;
const UNIT_SPACED = String.raw`(?:ms|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|years?|[KMGT]B|kB|kg|mg|g|lbs?|oz|km|cm|mm|mi|ft|ml|px|fps|[kMG]?Hz|kWh|kW|W|mAh|tokens?|°[CF])`;
const UNIT_TIGHT = String.raw`(?:k|K|M|x|×|h|m|s|B)`;
const COMPARE = String.raw`\s*(?:vs\.?|versus|→|->|to)\s*`;
const MEASURES = [
  new RegExp(String.raw`(?<=[$€£¥]\s?)\d+(?:,\d{3})*(?:\.\d+)?`, "g"),
  new RegExp(String.raw`${NUM}(?=\s?%)`, "g"),
  new RegExp(String.raw`${NUM}(?=\s?${UNIT_SPACED}\b)`, "g"),
  new RegExp(String.raw`${NUM}(?=${UNIT_TIGHT}\b)`, "g"),
  new RegExp(String.raw`${NUM}(?=%?${COMPARE}[$€£¥]?\d)`, "g"),
  new RegExp(String.raw`(?<=\d%?${COMPARE}[$€£¥]?)\d+(?:,\d{3})*(?:\.\d+)?`, "g"),
];
const LIST_ITEM = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+[^\n]*?(?<![\w.])\d/gm;
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/gm;
const TABLE_RULE = /^[ \t]*\|(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*$/gm;
const LABEL_LINE = /^[ \t]*(?![-*+•|]|\d+[.)])[^\n:]{1,40}:[ \t]+[^\n]*\d/gm;
const TICKET = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}(?![\w.]?\d)/g;
const PR = /(?<![\w&#])#\d{1,6}\b/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/g;
const IMAGE_PATH = /\S+\.(?:png|jpe?g|gif|webp|heic|avif)\b/gi;
const BEFORE_AFTER =
  /\bbefore\b[\s\S]*\bafter\b|\bafter\b[\s\S]*\bbefore\b|\bv\d+\b[\s\S]*\bv\d+\b|\bold\b[\s\S]*\bnew\b/i;

const count = (pattern: RegExp, text: string): number => text.match(pattern)?.length ?? 0;

/** Where each measure starts, so a number two patterns both match counts once. */
function measures(text: string): number {
  const starts = new Set<number>();
  for (const pattern of MEASURES)
    for (const match of text.matchAll(pattern)) starts.add(match.index);
  return starts.size;
}

/** Whether `text` (a finished reply) is worth the widget pass under `limits`, and which signals say so. */
export function widgetGate(text: string, limits: GateLimits = GATE_DEFAULTS): GateResult {
  const prose = text.replace(CODE_FENCE, "");
  const tableRows = count(TABLE_ROW, prose) - 2 * count(TABLE_RULE, prose);
  const keys = new Set([...(prose.match(TICKET) ?? []), ...(prose.match(PR) ?? [])]);
  const images =
    count(MARKDOWN_IMAGE, prose) + count(IMAGE_PATH, prose.replace(MARKDOWN_IMAGE, ""));
  const beforeAfter = BEFORE_AFTER.test(prose);
  const counts: Record<WidgetSignal, number> = {
    numbers: measures(prose),
    items: count(LIST_ITEM, prose) + Math.max(0, tableRows) + count(LABEL_LINE, prose),
    keys: keys.size,
    media: images,
  };
  const signals = WIDGET_SIGNALS.filter(
    (signal) =>
      counts[signal] >= limits[signal] || (signal === "media" && images >= 1 && beforeAfter),
  );
  return { eligible: signals.length > 0, signals, counts, beforeAfter };
}

/** `numbers 1 of 3, items 0 of 3, ...` for the host log. */
export function gateCounts(result: GateResult, limits: GateLimits): string {
  return WIDGET_SIGNALS.map(
    (signal) => `${signal} ${String(result.counts[signal])} of ${String(limits[signal])}`,
  ).join(", ");
}
