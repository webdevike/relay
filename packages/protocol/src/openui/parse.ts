/**
 * OpenUI Lang text -> `WidgetSpec`: the vendored lang-core parser builds an ElementNode tree,
 * which is converted to widget JSON and validated by the existing zod `WidgetNode` schema. Invalid
 * children are dropped (each with an error) instead of rejecting the whole tree.
 */
import type { ZodError } from "zod";
import { WidgetNode, type WidgetSpec } from "../widget";
import { isASTNode, literalValue, type ASTNode } from "./lang/parser/ast";
import { createParser } from "./lang/parser/parser";
import { isElementNode, type ElementNode, type ValidationErrorCode } from "./lang/parser/types";
import { relayLibrary, WIDGET_KIND_BY_NAME } from "./library";

export type OpenUIErrorCode =
  | ValidationErrorCode
  /** A node failed `WidgetNode` validation and was dropped. */
  | "invalid-widget"
  /** A sub-component (Row, Ticket, ...) or a non-component value sits where a widget belongs. */
  | "not-a-widget"
  /** An expression, `$variable` or `@function` where Relay only takes literal values. */
  | "unsupported-expression"
  /** A name is referenced but never defined. */
  | "unresolved"
  /** A statement is defined but not reachable from `root`. */
  | "orphaned"
  /** The program ends mid-statement (unclosed string, bracket or call). */
  | "incomplete"
  /** The parser threw; nothing rendered. */
  | "parse-exception";

export interface OpenUIError {
  code: OpenUIErrorCode;
  message: string;
  /** The statement (`name = ...`) the error belongs to. */
  statementId?: string;
  /** The component the error belongs to, e.g. "Stat". */
  component?: string;
  /** Prop path inside the component, e.g. "/value". */
  path?: string;
  /** Set when the widget still renders. */
  severity?: "warning";
}

export interface ParseOpenUIOptions {
  /** The text is a stream prefix (the fence is not closed yet): tolerate the unfinished tail. */
  partial?: boolean;
}

export interface ParseOpenUIResult {
  /** The validated widget tree, or null when the root is missing or invalid. */
  node: WidgetSpec | null;
  errors: OpenUIError[];
  /** The program is syntactically finished and every reference is defined. */
  complete: boolean;
}

const parser = createParser(relayLibrary.toJSONSchema(), relayLibrary.root);

/** Parses one ```openui block body. Never throws. */
export function parseOpenUI(text: string, opts: ParseOpenUIOptions = {}): ParseOpenUIResult {
  const partial = opts.partial === true;
  try {
    return convert(text, partial);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { node: null, errors: [{ code: "parse-exception", message }], complete: false };
  }
}

/** The end of a stream prefix cut inside a number: `3.`, `1e`, `1e-` (kept: the digits) or a lone
 * `-`, which would otherwise lex as an operator or a broken literal. */
const UNFINISHED_NUMBER = /(\d)(?:\.|[eE][+-]?)$|(^|\W)-$/;

function convert(text: string, partial: boolean): ParseOpenUIResult {
  const result = parser.parse(partial ? text.replace(UNFINISHED_NUMBER, "$1$2") : text);
  const errors: OpenUIError[] = result.meta.errors.map((e) =>
    withOptional({ code: e.code, message: e.message }, e),
  );
  const { incomplete, unresolved, orphaned, statementCount } = result.meta;
  if (!partial) {
    if (statementCount === 0)
      errors.push({ code: "no-root", message: "no statements: a program starts with `root = Component(...)`" });
    else if (incomplete)
      errors.push({ code: "incomplete", message: "the program ends mid-statement (unclosed string, bracket or call)" });
    for (const name of unresolved)
      errors.push({ code: "unresolved", message: `"${name}" is referenced but never defined`, statementId: name });
    for (const name of orphaned)
      errors.push({
        code: "orphaned",
        message: `"${name}" is defined but not reachable from root, so it does not render`,
        statementId: name,
        severity: "warning",
      });
  }
  const complete = !incomplete && unresolved.length === 0;
  if (!result.root) return { node: null, errors, complete };

  const node = validWidget(result.root, { errors, partial }) ?? null;
  return { node, errors, complete };
}

/** Repairs tried on one node while streaming before it is dropped. */
const MAX_REPAIRS = 8;

/** A widget element converted and validated, or undefined (with an error) when it is invalid.
 * While streaming, the unfinished tail of a node (an item whose fields are still arriving, a URL
 * cut short) is trimmed instead, so a tree that rendered keeps rendering as more text arrives. */
function validWidget(el: ElementNode, ctx: Ctx): WidgetSpec | undefined {
  const raw = widgetJSON(el, ctx);
  if (raw === undefined) return undefined;
  let parsed = WidgetNode.safeParse(raw);
  for (let i = 0; !parsed.success && ctx.partial && i < MAX_REPAIRS && trimInvalid(raw, parsed.error); i++)
    parsed = WidgetNode.safeParse(raw);
  if (parsed.success) return parsed.data;
  ctx.errors.push(invalid(el, parsed.error));
  return undefined;
}

interface Ctx {
  errors: OpenUIError[];
  partial: boolean;
}

type Json = unknown;

/** A widget element as raw widget JSON, or undefined (with an error) when it is not a widget. */
function widgetJSON(el: ElementNode, ctx: Ctx): Record<string, Json> | undefined {
  const kind = WIDGET_KIND_BY_NAME.get(el.typeName);
  if (kind === undefined) {
    ctx.errors.push(
      withOptional(
        { code: "not-a-widget", message: `${el.typeName} is not a widget; it only goes inside the widget that takes it` },
        { component: el.typeName, statementId: el.statementId },
      ),
    );
    return undefined;
  }
  const out: Record<string, Json> = { widget: kind, ...propsJSON(el, ctx) };
  if (kind === "button") buttonAction(out, el, ctx);
  if (kind === "table" && ctx.partial) dropUnfinishedRow(out);
  return out;
}

/** A component's props as JSON: nulls dropped, `children` validated child by child. */
function propsJSON(el: ElementNode, ctx: Ctx): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(el.props)) {
    if (key === "action") continue; // Button's action slot, mapped in `buttonAction`
    const json = key === "children" ? childrenJSON(value, ctx) : valueJSON(value, el, ctx);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/** A container's children: each one is validated on its own and dropped when invalid. */
function childrenJSON(value: unknown, ctx: Ctx): Json[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Json[] = [];
  for (const child of value) {
    // Unresolved references materialize as null; they are reported once, as `unresolved`.
    if (child === null || child === undefined) continue;
    if (!isElementNode(child)) {
      ctx.errors.push({ code: "not-a-widget", message: `a container child must be a widget, got ${JSON.stringify(child)}` });
      continue;
    }
    const widget = validWidget(child, ctx);
    if (widget) out.push(widget);
  }
  return out;
}

function valueJSON(value: unknown, owner: ElementNode, ctx: Ctx): Json {
  if (value === null || value === undefined) return undefined;
  if (isElementNode(value))
    return WIDGET_KIND_BY_NAME.has(value.typeName) ? widgetJSON(value, ctx) : propsJSON(value, ctx);
  if (isASTNode(value)) {
    const literal = literalValue(value);
    if (literal) return valueJSON(literal.v, owner, ctx);
    ctx.errors.push(
      withOptional(
        { code: "unsupported-expression", message: "Relay widgets take literal values only (no expressions, $variables or @functions)" },
        { component: owner.typeName, statementId: owner.statementId },
      ),
    );
    return undefined;
  }
  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (const item of value) {
      const json = valueJSON(item, owner, ctx);
      if (json !== undefined) items.push(json);
    }
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      const json = valueJSON(item, owner, ctx);
      if (json !== undefined) out[key] = json;
    }
    return out;
  }
  return value;
}

/** `@ToAssistant("text")` -> `reply`, `@OpenUrl("https://...")` -> `url` (the first of either in an
 * `Action([...])`). A button with neither sends its label, as the prompt promises. */
function buttonAction(out: Record<string, Json>, el: ElementNode, ctx: Ctx): void {
  const action = el.props["action"];
  const step = isASTNode(action) ? firstStep(action) : undefined;
  if (step) {
    const arg = step.mappedProps?.[step.name === "OpenUrl" ? "url" : "message"] ?? step.args[0];
    const literal = arg && literalValue(arg);
    if (literal && typeof literal.v === "string") {
      out[step.name === "OpenUrl" ? "url" : "reply"] = literal.v;
    } else {
      ctx.errors.push(
        withOptional(
          { code: "unsupported-expression", message: `@${step.name} takes one string literal`, component: "Button", path: "/action" },
          { statementId: el.statementId },
        ),
      );
    }
  } else if (action !== undefined && action !== null) {
    ctx.errors.push(
      withOptional(
        { code: "type-mismatch", message: 'Button action must be @ToAssistant("text") or @OpenUrl("https://...")', component: "Button", path: "/action" },
        { statementId: el.statementId },
      ),
    );
  }
  labelReply(out);
}

function labelReply(button: Record<string, Json>): void {
  if (button["reply"] === undefined && button["url"] === undefined) button["reply"] = button["label"];
}

type CompNode = Extract<ASTNode, { k: "Comp" }>;

function firstStep(node: ASTNode): CompNode | undefined {
  if (node.k !== "Comp") return undefined;
  if (node.name === "ToAssistant" || node.name === "OpenUrl") return node;
  if (node.name !== "Action") return undefined;
  const list = node.args[0];
  if (list?.k !== "Arr") return undefined;
  for (const item of list.els) {
    const step = firstStep(item);
    if (step) return step;
  }
  return undefined;
}

/** While streaming, the last table row may still be missing cells; hide it until it is whole. */
function dropUnfinishedRow(table: Record<string, Json>): void {
  const { columns, rows } = table;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return;
  const last: unknown = rows[rows.length - 1];
  if (Array.isArray(last) && last.length !== columns.length) table["rows"] = rows.slice(0, -1);
}

/** Streaming repair: removes what the first zod issue points at (the array item holding it, else
 * the field), then re-applies the button default. False when there is nothing left to remove. */
function trimInvalid(raw: Record<string, Json>, error: ZodError): boolean {
  const path = error.issues[0]?.path ?? [];
  let cut = path.length - 1;
  for (let i = cut; i >= 0; i--) {
    if (typeof path[i] === "number") {
      cut = i;
      break;
    }
  }
  if (cut < 0) return false;
  let parent: unknown = raw;
  for (const key of path.slice(0, cut))
    parent = typeof parent === "object" && parent !== null ? Reflect.get(parent, key) : undefined;
  const key = path[cut];
  if (Array.isArray(parent) && typeof key === "number" && key < parent.length) parent.splice(key, 1);
  else if (typeof parent === "object" && parent !== null && key !== undefined && key in parent)
    Reflect.deleteProperty(parent, key);
  else return false;
  if (raw["widget"] === "button") labelReply(raw);
  return true;
}

function invalid(el: ElementNode, error: ZodError): OpenUIError {
  const detail = error.issues
    .map((issue) => (issue.path.length ? `/${issue.path.join("/")}: ${issue.message}` : issue.message))
    .join("; ");
  return withOptional(
    { code: "invalid-widget", message: `${el.typeName} dropped: ${detail}`, component: el.typeName },
    { statementId: el.statementId },
  );
}

/** Copies the optional fields that are set (exactOptionalPropertyTypes forbids explicit undefined). */
function withOptional(
  base: OpenUIError,
  extra: { statementId?: string | undefined; component?: string | undefined; path?: string | undefined; severity?: "warning" | undefined },
): OpenUIError {
  const out: OpenUIError = { ...base };
  if (extra.statementId !== undefined) out.statementId = extra.statementId;
  if (extra.component !== undefined) out.component = extra.component;
  if (extra.path !== undefined) out.path = extra.path;
  if (extra.severity !== undefined) out.severity = extra.severity;
  return out;
}
