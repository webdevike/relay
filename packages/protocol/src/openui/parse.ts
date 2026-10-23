/**
 * OpenUI Lang text -> `WidgetSpec`: the vendored lang-core parser builds an ElementNode tree whose
 * dynamic props stay AST; they are evaluated against the current `$variable` state, converted to
 * widget JSON and validated by the existing zod `WidgetNode` schema. Invalid children are dropped
 * (each with an error) instead of rejecting the whole tree. `parseOpenUI` evaluates against the
 * declared defaults; `createOpenUIRuntime` (./runtime) keeps state and runs button actions.
 */
import type { ZodError } from "zod";
import { WidgetNode, type WidgetSpec } from "../widget";
import { isASTNode, type ASTNode } from "./lang/parser/ast";
import { createParser } from "./lang/parser/parser";
import {
  isElementNode,
  type ActionPlan,
  type ElementNode,
  type ParseResult,
  type ValidationErrorCode,
} from "./lang/parser/types";
import { evaluate, isActionPlan } from "./lang/runtime/evaluator";
import { relayLibrary, WIDGET_KIND_BY_NAME } from "./library";

export type OpenUIErrorCode =
  | ValidationErrorCode
  /** A node failed `WidgetNode` validation and was dropped. */
  | "invalid-widget"
  /** A sub-component (Row, Ticket, ...) or a non-component value sits where a widget belongs. */
  | "not-a-widget"
  /** Query, Mutation, @Run or another construct Relay widgets don't run. */
  | "unsupported-expression"
  /** Evaluating the program against the current state threw; nothing rendered. */
  | "runtime-error"
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

/** One parsed program: the lang-core result plus the errors found before evaluation. */
export interface Program {
  result: ParseResult | null;
  errors: OpenUIError[];
  complete: boolean;
  partial: boolean;
}

/** One step of a button's action, evaluated when the tap reaches it: an @step call (or nested
 * Action) as AST, or a plan already evaluated. */
export type ActionStepSource = ASTNode | ActionPlan;

/** What a tree built against the current state hands back to the runtime. */
export interface Built extends ParseOpenUIResult {
  /** Button `action` id -> its steps, in order. */
  actions: Map<string, ActionStepSource[]>;
  /** Input `bind` id -> the `$variable` it writes. */
  bindings: Map<string, string>;
}

const parser = createParser(relayLibrary.toJSONSchema(), relayLibrary.root);

/** Parses one ```openui block body against its declared `$variable` defaults. Never throws. */
export function parseOpenUI(text: string, opts: ParseOpenUIOptions = {}): ParseOpenUIResult {
  const program = compileProgram(text, opts.partial === true);
  const defaults = program.result?.stateDeclarations ?? {};
  const { node, errors, complete } = buildTree(program, (name) => defaults[name] ?? null);
  return { node, errors, complete };
}

/** The end of a stream prefix cut inside a number: `3.`, `1e`, `1e-` (kept: the digits) or a lone
 * `-`, which would otherwise lex as an operator or a broken literal. */
const UNFINISHED_NUMBER = /(\d)(?:\.|[eE][+-]?)$|(^|\W)-$/;

/** Parses the text once; the program is then evaluated by `buildTree` per state. Never throws. */
export function compileProgram(text: string, partial: boolean): Program {
  let result: ParseResult;
  try {
    result = parser.parse(partial ? text.replace(UNFINISHED_NUMBER, "$1$2") : text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: null, errors: [{ code: "parse-exception", message }], complete: false, partial };
  }
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
  for (const { statementId } of [...result.queryStatements, ...result.mutationStatements])
    errors.push({ code: "unsupported-expression", message: "Relay widgets don't run Query or Mutation", statementId });
  return { result, errors, complete: !incomplete && unresolved.length === 0, partial };
}

/** Evaluates a program against `getState` into a validated tree. Never throws. */
export function buildTree(program: Program, getState: (name: string) => unknown): Built {
  const ctx: Ctx = {
    errors: [...program.errors],
    partial: program.partial,
    evaluate: (node) => evaluate(node, { getState, resolveRef: () => null }),
    getState,
    actions: new Map(),
    bindings: new Map(),
  };
  const built = (node: WidgetSpec | null): Built => ({
    node,
    errors: ctx.errors,
    complete: program.complete,
    actions: ctx.actions,
    bindings: ctx.bindings,
  });
  const { result } = program;
  if (!result) return built(null);
  try {
    const root = result.root ?? (result.rootExpression ? ctx.evaluate(result.rootExpression) : null);
    if (!isElementNode(root)) return built(null);
    return built(validWidget(root, ctx, "root") ?? null);
  } catch (error) {
    ctx.errors.push({ code: "runtime-error", message: error instanceof Error ? error.message : String(error) });
    ctx.actions.clear();
    ctx.bindings.clear();
    return built(null);
  }
}

/** Repairs tried on one node while streaming before it is dropped. */
const MAX_REPAIRS = 8;

/** A widget element converted and validated, or undefined (with an error) when it is invalid.
 * While streaming, the unfinished tail of a node (an item whose fields are still arriving, a URL
 * cut short) is trimmed instead, so a tree that rendered keeps rendering as more text arrives. */
function validWidget(el: ElementNode, ctx: Ctx, path: string): WidgetSpec | undefined {
  const raw = widgetJSON(el, ctx, path);
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
  evaluate: (node: ASTNode) => unknown;
  getState: (name: string) => unknown;
  actions: Map<string, ActionStepSource[]>;
  bindings: Map<string, string>;
}

type Json = unknown;

/** Props typed string per component; an expression yielding a number there renders as its text. */
const STRING_PROPS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(relayLibrary.toJSONSchema().$defs ?? {}).map(([name, def]) => [
    name,
    new Set(
      Object.entries(def.properties ?? {})
        .filter(([, prop]) => typeof prop === "object" && prop !== null && "type" in prop && prop.type === "string")
        .map(([key]) => key),
    ),
  ]),
);

/** A widget element as raw widget JSON, or undefined (with an error) when it is not a widget.
 * `path` names the node for runtime ids; a statement's own name is preferred, being stable while
 * the program streams. */
function widgetJSON(el: ElementNode, ctx: Ctx, path: string): Record<string, Json> | undefined {
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
  const id = el.statementId ?? path;
  const out: Record<string, Json> = { widget: kind, ...propsJSON(el, ctx, id) };
  if (kind === "button") buttonAction(out, el, ctx, id);
  if (kind === "input") inputBinding(out, el, ctx, id);
  if (kind === "table" && ctx.partial) dropUnfinishedRow(out);
  return out;
}

/** A component's props as JSON: nulls dropped, `children` validated child by child. */
function propsJSON(el: ElementNode, ctx: Ctx, path: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(el.props)) {
    if (key === "action") continue; // Button's action slot, mapped in `buttonAction`
    const value = isASTNode(raw) ? ctx.evaluate(raw) : raw;
    const json =
      key === "children"
        ? childrenJSON(value, ctx, `${path}/${key}`)
        : typeof value === "number" && Number.isFinite(value) && STRING_PROPS.get(el.typeName)?.has(key)
          ? String(value)
          : valueJSON(value, el, ctx, `${path}/${key}`);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/** A container's children: each one is validated on its own and dropped when invalid. */
function childrenJSON(value: unknown, ctx: Ctx, path: string): Json[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Json[] = [];
  value.forEach((item: unknown, i) => {
    const child = isASTNode(item) ? ctx.evaluate(item) : item;
    // Unresolved references materialize as null; they are reported once, as `unresolved`.
    // A conditional child (`$open ? Text("x") : null`) evaluates to null when hidden.
    if (child === null || child === undefined) return;
    if (!isElementNode(child)) {
      ctx.errors.push({ code: "not-a-widget", message: `a container child must be a widget, got ${JSON.stringify(child)}` });
      return;
    }
    const widget = validWidget(child, ctx, `${path}/${String(i)}`);
    if (widget) out.push(widget);
  });
  return out;
}

function valueJSON(raw: unknown, owner: ElementNode, ctx: Ctx, path: string): Json {
  const value = isASTNode(raw) ? ctx.evaluate(raw) : raw;
  if (value === null || value === undefined || isActionPlan(value)) return undefined;
  if (isElementNode(value))
    return WIDGET_KIND_BY_NAME.has(value.typeName) ? widgetJSON(value, ctx, path) : propsJSON(value, ctx, path);
  if (Array.isArray(value)) {
    const items: Json[] = [];
    value.forEach((item: unknown, i) => {
      const json = valueJSON(item, owner, ctx, `${path}/${String(i)}`);
      if (json !== undefined) items.push(json);
    });
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      const json = valueJSON(item, owner, ctx, `${path}/${key}`);
      if (json !== undefined) out[key] = json;
    }
    return out;
  }
  return value;
}

/** `id`, or `id#2`, `id#3`, ... when a repeated statement or loop already used it. */
function uniqueId(id: string, taken: ReadonlyMap<string, unknown>): string {
  let unique = id;
  for (let n = 2; taken.has(unique); n++) unique = `${id}#${String(n)}`;
  return unique;
}

/** A button's action, evaluated now. With a local step (@Set, @Reset) it becomes an `action` id the
 * renderer dispatches to the runtime; otherwise its first @ToAssistant is `reply` and @OpenUrl
 * `url`, as static widgets have. A button with no action sends its label, as the prompt promises. */
function buttonAction(out: Record<string, Json>, el: ElementNode, ctx: Ctx, id: string): void {
  const raw = el.props["action"];
  if (raw === null || raw === undefined) {
    labelReply(out);
    return;
  }
  const plan = isASTNode(raw) ? ctx.evaluate(raw) : raw;
  const error = (code: OpenUIErrorCode, message: string) =>
    ctx.errors.push(withOptional({ code, message, component: "Button", path: "/action" }, { statementId: el.statementId }));
  if (!isActionPlan(plan)) {
    error("type-mismatch", 'Button action must be an @step or Action([...]), e.g. @ToAssistant("text")');
    labelReply(out);
    return;
  }
  if (plan.steps.some((step) => step.type === "set" || step.type === "reset")) {
    const actionId = uniqueId(id, ctx.actions);
    // Kept per step, so a later step reads the state the earlier ones set.
    const list = isASTNode(raw) && raw.k === "Comp" && raw.name === "Action" ? raw.args[0] : undefined;
    ctx.actions.set(actionId, list?.k === "Arr" ? list.els : [plan]);
    out["action"] = actionId;
    return;
  }
  const step = plan.steps.find((s) => s.type === "continue_conversation" || s.type === "open_url");
  if (step?.type === "open_url") out["url"] = step.url;
  else if (step?.type === "continue_conversation") out["reply"] = step.message;
  else error("unsupported-expression", "Relay buttons run @ToAssistant, @OpenUrl, @Set and @Reset only");
  labelReply(out);
}

function labelReply(button: Record<string, Json>): void {
  if (button["reply"] === undefined && button["url"] === undefined && button["action"] === undefined)
    button["reply"] = button["label"];
}

/** `Input(..., $name)`: the field shows `$name` and typing writes it through the `bind` id. */
function inputBinding(out: Record<string, Json>, el: ElementNode, ctx: Ctx, id: string): void {
  const raw = el.props["value"];
  if (!isASTNode(raw) || raw.k !== "StateRef") return;
  const bindId = uniqueId(id, ctx.bindings);
  ctx.bindings.set(bindId, raw.n);
  out["bind"] = bindId;
  const value = ctx.getState(raw.n);
  out["value"] = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
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
