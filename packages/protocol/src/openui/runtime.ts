/**
 * A live OpenUI Lang widget: `$variable` state, expressions evaluated against it, and button
 * actions that run local steps (@Set, @Reset) here and hand external ones (@ToAssistant,
 * @OpenUrl) back to the host. Pure TypeScript (no Node, DOM or code evaluation), so it runs under
 * Hermes and in the Electron renderer.
 */
import type { ParseOpenUIOptions, ParseOpenUIResult } from "./parse";
import { buildTree, compileProgram, type Built, type Program } from "./parse";
import { isASTNode } from "./lang/parser/ast";
import { evaluate, isActionPlan, type EvaluationContext } from "./lang/runtime/evaluator";
import { createStore } from "./lang/runtime/store";

export interface OpenUIRuntime {
  /** The tree evaluated against the current state; the same object until state or text changes. */
  snapshot(): ParseOpenUIResult;
  /** Runs a button's `action`: local steps in order, then returns the first external step for the
   * host to perform (`reply` sends text as the next turn, `url` opens a link). Unknown ids: `{}`. */
  dispatch(actionId: string, input?: { value?: string }): { reply?: string; url?: string };
  /** Writes an Input's typed text to the `$variable` behind its `bind` id. */
  setInput(bindingId: string, value: string): void;
  /** Called after every state or text change; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
  /** Re-parses streamed text; `$variables` the user changed keep their values. */
  update(text: string, opts?: ParseOpenUIOptions): void;
}

export function createOpenUIRuntime(text: string, opts: ParseOpenUIOptions = {}): OpenUIRuntime {
  const store = createStore();
  const listeners = new Set<() => void>();
  let program: Program = compileProgram(text, opts.partial === true);
  let source = { text, partial: opts.partial === true };
  let built: Built | null = null;
  let snapshot: ParseOpenUIResult | null = null;
  /** Inside `dispatch` and `update`: listeners hear once, at the end. */
  let batching = false;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  store.subscribe(() => {
    built = null;
    snapshot = null;
    if (!batching) notify();
  });
  const defaults = () => program.result?.stateDeclarations ?? {};
  store.initialize(defaults(), {});
  const current = (): Built => {
    built ??= buildTree(program, (name) => store.get(name) ?? null);
    return built;
  };

  return {
    snapshot() {
      if (!snapshot) {
        const { node, errors, complete } = current();
        snapshot = { node, errors, complete };
      }
      return snapshot;
    },

    dispatch(actionId, input = {}) {
      const sources = current().actions.get(actionId);
      if (!sources) return {};
      const out: { reply?: string; url?: string } = {};
      const ctx: EvaluationContext = {
        getState: (name) => store.get(name) ?? null,
        resolveRef: () => null,
        ...(input.value === undefined ? {} : { extraScope: { $value: input.value } }),
      };
      const before = store.getSnapshot();
      batching = true;
      try {
        // Each step is evaluated when reached, so it sees what the steps before it set.
        for (const source of sources) {
          const plan = isASTNode(source) ? evaluate(source, ctx) : source;
          if (!isActionPlan(plan)) continue;
          for (const step of plan.steps) {
            if (step.type === "set") store.set(step.target, evaluate(step.valueAST, ctx));
            else if (step.type === "reset")
              for (const target of step.targets) store.set(target, defaults()[target] ?? null, { pristine: true });
            else if (step.type === "continue_conversation") out.reply ??= step.message;
            else if (step.type === "open_url") out.url ??= step.url;
          }
        }
      } finally {
        batching = false;
      }
      if (store.getSnapshot() !== before) notify();
      return out;
    },

    setInput(bindingId, value) {
      const target = current().bindings.get(bindingId);
      if (target !== undefined) store.set(target, value);
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    update(nextText, nextOpts = {}) {
      const next = { text: nextText, partial: nextOpts.partial === true };
      if (next.text === source.text && next.partial === source.partial) return;
      source = next;
      program = compileProgram(next.text, next.partial);
      built = null;
      snapshot = null;
      batching = true;
      store.initialize(defaults(), {});
      batching = false;
      notify();
    },
  };
}
