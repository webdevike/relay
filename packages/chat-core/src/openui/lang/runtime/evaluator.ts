// @ts-nocheck: vendored upstream code, type-checked upstream under its own tsconfig (see LICENSE-openui).
// From github.com/thesysdev/openui packages/lang-core/src/runtime/evaluator.ts, MIT License, Copyright (c) Thesys Inc.
// ─────────────────────────────────────────────────────────────────────────────
// AST evaluator — resolves AST nodes to runtime values.
// Framework-agnostic. No React imports.
// (Relay fork: local state only; see LICENSE-openui for what was removed.)
// ─────────────────────────────────────────────────────────────────────────────

import type { ASTNode } from "../parser/ast";
import { isASTNode, toLiteralAST } from "../parser/ast";
import { ACTION_STEPS, BUILTIN_CALLS, BUILTIN_STEPS, BUILTINS, isStep, toNumber } from "../parser/builtins";
import { nameArgs } from "../parser/materialize";
import type { ActionPlan, ActionStep, ElementNode, ParamDef } from "../parser/types";

export interface EvaluationContext {
  /** Read $variable from the store */
  getState(name: string): unknown;
  /** Resolve a reference to another declaration's evaluated value */
  resolveRef(name: string): unknown;
  /** Extra scope for $value injection */
  extraScope?: Record<string, unknown>;
}

/**
 * Evaluate an AST node to a runtime value.
 */
export function evaluate(node: ASTNode, context: EvaluationContext): unknown {
  // Relay fork: materialized values (an ElementNode inside an expression) are already values
  if (!isASTNode(node)) return node;
  switch (node.k) {
    // ── Literals ──────────────────────────────────────────────────────────
    case "Str":
      return node.v;
    case "Num":
      return node.v;
    case "Bool":
      return node.v;
    case "Null":
      return null;
    case "Ph":
      return null;

    // ── State references ──────────────────────────────────────────────────
    case "StateRef":
      return context.extraScope?.[node.n] ?? context.getState(node.n);

    // ── References ────────────────────────────────────────────────────────
    case "Ref":
    case "RuntimeRef":
      return context.resolveRef(node.n);

    // ── Collections ───────────────────────────────────────────────────────
    case "Arr":
      return node.els.map((el) => evaluate(el, context));
    case "Obj":
      return Object.fromEntries(node.entries.map(([k, v]) => [k, evaluate(v, context)]));

    // ── Component ─────────────────────────────────────────────────────────
    case "Comp": {
      // Built-ins coerce their args, so they skip validation. Lazy ones get them unevaluated.
      const builtin = BUILTINS[node.name];
      if (builtin) {
        if (builtin.lazy) return evaluateLazyBuiltin(node.name, node.args, context);
        return builtin.fn!(evaluateArgs(node, context));
      }
      // Built-in steps and Action([...]) → an ActionPlan
      if (isStep(node.name)) return evaluateActionCall(node, context);
      // Relay fork: a catalog component keeps its named props as AST; the caller evaluates them.
      if (node.mappedProps) {
        const result: ElementNode = {
          type: "element",
          typeName: node.name,
          props: { ...node.mappedProps },
          partial: false,
          hasDynamicProps: true,
        };
        return result;
      }
      return null;
    }

    // ── Binary operators ──────────────────────────────────────────────────
    case "BinOp": {
      // Short-circuit operators evaluate lazily
      if (node.op === "&&") {
        const left = evaluate(node.left, context);
        return left ? evaluate(node.right, context) : left;
      }
      if (node.op === "||") {
        const left = evaluate(node.left, context);
        return left ? left : evaluate(node.right, context);
      }

      const left = evaluate(node.left, context);
      const right = evaluate(node.right, context);

      switch (node.op) {
        case "+":
          if (typeof left === "string" || typeof right === "string") {
            // Treat null/undefined as "" for string concat to avoid "textnull"
            return String(left ?? "") + String(right ?? "");
          }
          return toNumber(left) + toNumber(right);
        case "-":
          return toNumber(left) - toNumber(right);
        case "*":
          return toNumber(left) * toNumber(right);
        case "/":
          // DSL design choice: division by zero returns 0 instead of JavaScript's Infinity/NaN.
          return toNumber(right) === 0 ? 0 : toNumber(left) / toNumber(right);
        case "%":
          return toNumber(right) === 0 ? 0 : toNumber(left) % toNumber(right);
        case "==":
          // Use loose equality so that e.g. 5 == "5" is true,
          // consistent with the toNumber coercion used by comparison operators.
          return left == right;
        case "!=":
          return left != right;
        case ">":
          return toNumber(left) > toNumber(right);
        case "<":
          return toNumber(left) < toNumber(right);
        case ">=":
          return toNumber(left) >= toNumber(right);
        case "<=":
          return toNumber(left) <= toNumber(right);
        default:
          return null;
      }
    }

    // ── Unary operators ───────────────────────────────────────────────────
    case "UnaryOp":
      if (node.op === "!") {
        return !evaluate(node.operand, context);
      }
      if (node.op === "-") {
        return -toNumber(evaluate(node.operand, context));
      }
      return null;

    // ── Ternary ───────────────────────────────────────────────────────────
    case "Ternary": {
      const cond = evaluate(node.cond, context);
      return cond ? evaluate(node.then, context) : evaluate(node.else, context);
    }

    // ── Member access ─────────────────────────────────────────────────────
    case "Member": {
      const obj = evaluate(node.obj, context) as any;
      if (obj == null) return null;
      // Array pluck: if obj is an array, extract field from every element
      if (Array.isArray(obj)) {
        if (node.field === "length") return obj.length;
        return obj.map((item: any) => item?.[node.field] ?? null);
      }
      return Object.prototype.hasOwnProperty.call(obj, node.field) ? obj[node.field] : null;
    }

    // ── Index access ──────────────────────────────────────────────────────
    case "Index": {
      const obj = evaluate(node.obj, context) as any;
      const idx = evaluate(node.index, context);
      if (obj == null || idx == null) return null;
      if (Array.isArray(obj)) {
        return obj[toNumber(idx)];
      }
      return Object.prototype.hasOwnProperty.call(obj, String(idx)) ? obj[String(idx)] : null;
    }

    // Relay fork: inline `$x = value` assignments bind reactive props upstream; unsupported here.
    case "Assign":
      return null;
  }
  return null;
}

// @Round(x, 1) -> {number: x, decimals: 1}
function evaluateArgs(
  node: ASTNode & { k: "Comp" },
  context: EvaluationContext,
  params: ParamDef[] = BUILTIN_CALLS.get(node.name)?.params ?? [],
): Record<string, unknown> {
  // The parser names args in mappedProps; an AST from parseExpression() alone is named here
  const named = node.mappedProps ?? nameArgs(node.args, params);
  const args: Record<string, unknown> = {};
  for (const key in named) args[key] = evaluate(named[key]!, context);
  return args;
}

/** True for an evaluated action plan (`{ steps: [...] }`). */
export function isActionPlan(value: unknown): value is ActionPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { steps?: unknown }).steps)
  );
}

/** Flatten plans (and stray step objects) into one plan; other values are dropped. */
function flattenPlans(values: unknown[]): ActionPlan {
  return {
    steps: values.flatMap((v): ActionStep[] => (isActionPlan(v) ? v.steps : [])),
  };
}

/** A step call is a one-step plan, an invalid step an empty plan; Action([...]) flattens. */
function evaluateActionCall(node: ASTNode & { k: "Comp" }, context: EvaluationContext): ActionPlan {
  const { name, args } = node;
  if (name === "Action") {
    const list = args.length > 0 ? evaluate(args[0], context) : [];
    return flattenPlans(Array.isArray(list) ? list : []);
  }
  const def = BUILTIN_STEPS[name]!;
  const step = def.step ? def.step(evaluateArgs(node, context)) : evaluateLazyStep(name, args);
  return { steps: step ? [step] : [] };
}

/** The steps whose args are refs, read as AST. */
function evaluateLazyStep(name: string, args: ASTNode[]): ActionStep | null {
  switch (name) {
    case "Set": {
      // Set($varName, value). valueAST is evaluated at click time by the runtime;
      // loop variables (e.g. t.id from Each) are pre-resolved by Each's substituteRef.
      if (args.length < 2 || args[0].k !== "StateRef") return null;
      return { type: ACTION_STEPS.Set, target: args[0].n, valueAST: args[1] };
    }
    case "Reset": {
      // Reset($var1, $var2, ...) restores declared defaults at runtime.
      const targets = args
        .filter((a): a is ASTNode & { k: "StateRef" } => a.k === "StateRef")
        .map((a) => a.n);
      if (targets.length === 0) return null;
      return { type: ACTION_STEPS.Reset, targets };
    }
    // Relay fork: @Run (queries/mutations) is not supported.
    default:
      return null;
  }
}

/**
 * Substitute all Ref(varName) nodes in an AST tree with a literal value.
 * This pre-resolves loop variables so deferred expressions (like Action steps)
 * don't lose scope when evaluated later at click time.
 */
function substituteRef(node: ASTNode, varName: string, value: unknown): ASTNode {
  if (!isASTNode(node)) return node;
  switch (node.k) {
    case "Ref":
      return node.n === varName ? toLiteralAST(value) : node;
    case "Member": {
      // Member access on the loop var: t.id → resolve t, then access .id
      if (isASTNode(node.obj)) {
        const subObj = substituteRef(node.obj as ASTNode, varName, value);
        // If obj resolved to a literal, we can inline the member access result
        if (subObj.k === "Obj") {
          const entry = subObj.entries.find(([k]) => k === node.field);
          if (entry) return entry[1];
        }
        return { ...node, obj: subObj };
      }
      return node;
    }
    case "Index":
      return {
        ...node,
        obj: isASTNode(node.obj) ? substituteRef(node.obj as ASTNode, varName, value) : node.obj,
        index: isASTNode(node.index)
          ? substituteRef(node.index as ASTNode, varName, value)
          : node.index,
      };
    case "BinOp":
      return {
        ...node,
        left: substituteRef(node.left, varName, value),
        right: substituteRef(node.right, varName, value),
      };
    case "UnaryOp":
      return { ...node, operand: substituteRef(node.operand, varName, value) };
    case "Ternary":
      return {
        ...node,
        cond: substituteRef(node.cond, varName, value),
        then: substituteRef(node.then, varName, value),
        else: substituteRef(node.else, varName, value),
      };
    case "Arr":
      return { ...node, els: node.els.map((e) => substituteRef(e, varName, value)) };
    case "Obj":
      return {
        ...node,
        entries: node.entries.map(
          ([k, v]) => [k, substituteRef(v, varName, value)] as [string, ASTNode],
        ),
      };
    case "Comp": {
      const sub = (a: ASTNode) => substituteRef(a, varName, value);
      const result = { ...node, args: node.args.map(sub) };
      if (node.mappedProps) result.mappedProps = mapValues(node.mappedProps, sub);
      return result;
    }
    case "Assign":
      return { ...node, value: substituteRef(node.value, varName, value) };
    default:
      return node;
  }
}

function mapValues(
  record: Record<string, ASTNode>,
  fn: (node: ASTNode) => ASTNode,
): Record<string, ASTNode> {
  const out: Record<string, ASTNode> = {};
  for (const key in record) out[key] = fn(record[key]!);
  return out;
}

/**
 * Each(array, varName, template) — evaluate template once per array item.
 * varName is user-defined (e.g. `issue`, `ticket`) — no $ prefix collision.
 *
 * Before evaluation, substitutes all Ref(varName) in the template with the
 * current item's literal value. This ensures deferred expressions (like
 * Action/Set steps) capture concrete values instead of dangling loop refs.
 */
function evaluateLazyBuiltin(name: string, args: ASTNode[], context: EvaluationContext): unknown {
  if (name === "Each") {
    if (args.length < 3) return [];
    const arr = evaluate(args[0], context);
    if (!Array.isArray(arr)) return [];

    const varName =
      args[1].k === "Ref" ? args[1].n : args[1].k === "Str" ? (args[1] as any).v : null;
    if (!varName) return [];
    const template = args[2];

    return arr.map((item) => {
      // Pre-substitute loop variable refs with concrete values in the template AST.
      // This captures the item for deferred expressions (Action steps evaluated at click time).
      const substituted = substituteRef(template, varName, item);
      const childCtx: EvaluationContext = {
        ...context,
        resolveRef: (refName: string) => {
          if (refName === varName) return item;
          return context.resolveRef(refName);
        },
      };
      return evaluate(substituted, childCtx);
    });
  }
  return null;
}
