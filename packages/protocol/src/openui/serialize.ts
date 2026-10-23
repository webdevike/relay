/**
 * `WidgetSpec` -> OpenUI Lang text, through the vendored lang-core serializer. Container children
 * become named statements (`stat1 = Stat(...)`) so the program reads, and streams, top-down.
 */
import type { WidgetSpec } from "../widget";
import type { ASTNode } from "./lang/parser/ast";
import { jsonToOpenUI } from "./lang/parser/serialize";
import type { ElementNode } from "./lang/parser/types";
import { relayLibrary } from "./library";

/** For each widget, the sub-component that holds the items of each structured field. */
const SUB_COMPONENTS: Partial<Record<WidgetSpec["widget"], Record<string, string>>> = {
  chart: { series: "Series" },
  stat: { delta: "Delta" },
  tickets: { tickets: "Ticket" },
  compare: { before: "Side", after: "Side" },
  gallery: { images: "GalleryImage" },
  recipe: { ingredients: "Ingredient" },
  rows: { rows: "Row" },
  emails: { emails: "Email" },
  pr: { reviewers: "Reviewer", checks: "PrCheck", files: "PrFile" },
  table: { columns: "Column", rows: "Cell" },
  list: { items: "ListItem" },
  timeline: { items: "TimelineEntry" },
  tabs: { tabs: "Tab" },
};

/** Statement names handed out so far: a per-widget counter and the names in pre-order. */
interface Names {
  counts: Map<string, number>;
  order: string[];
}

/** Serializes a validated widget tree to an OpenUI Lang program, statements top-down from `root`. */
export function toOpenUI(node: WidgetSpec): string {
  const names: Names = { counts: new Map(), order: [] };
  const program = jsonToOpenUI(widgetElement(node, names, false), relayLibrary);
  // lang-core emits children before parents; reorder so each statement streams after its parent.
  // Strings are JSON-escaped, so every statement is exactly one line.
  const [root = "", ...rest] = program.split("\n");
  const byName = new Map(rest.map((line) => [line.slice(0, line.indexOf(" = ")), line]));
  return [root, ...names.order.flatMap((name) => byName.get(name) ?? [])].join("\n");
}

function element(typeName: string, props: Record<string, unknown>): ElementNode {
  return { type: "element", typeName, props, partial: false };
}

function widgetElement(node: WidgetSpec, names: Names, named: boolean): ElementNode {
  const el = element(`${node.widget.charAt(0).toUpperCase()}${node.widget.slice(1)}`, {});
  if (named && node.widget !== "divider") {
    const n = (names.counts.get(node.widget) ?? 0) + 1;
    names.counts.set(node.widget, n);
    el.statementId = `${node.widget}${String(n)}`;
    names.order.push(el.statementId);
  }
  const subs = SUB_COMPONENTS[node.widget] ?? {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "widget" || value === undefined) continue;
    // A button's reply or url goes in its one action slot, below.
    if (node.widget === "button" && (key === "reply" || key === "url")) continue;
    if (key === "children") el.props[key] = childElements(value as WidgetSpec[], names);
    else el.props[key] = subValue(value, subs[key], names);
  }
  if (node.widget === "button") {
    el.props["action"] =
      node.reply !== undefined ? step("ToAssistant", node.reply) : step("OpenUrl", node.url ?? "");
  }
  return el;
}

function childElements(children: WidgetSpec[], names: Names): ElementNode[] {
  return children.map((child) => widgetElement(child, names, true));
}

/** A field value with its plain objects (also inside arrays and table rows) as `sub` elements. */
function subValue(value: unknown, sub: string | undefined, names: Names): unknown {
  if (Array.isArray(value)) return value.map((item) => subValue(item, sub, names));
  if (sub === undefined || typeof value !== "object" || value === null) return value;
  const props: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    props[key] = key === "children" ? childElements(item as WidgetSpec[], names) : item;
  }
  return element(sub, props);
}

function step(name: "ToAssistant" | "OpenUrl", arg: string): ASTNode {
  return { k: "Comp", name, args: [{ k: "Str", v: arg }] };
}
