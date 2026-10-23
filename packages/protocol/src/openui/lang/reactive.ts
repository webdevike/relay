// @ts-nocheck: vendored upstream code, type-checked upstream under its own tsconfig (see LICENSE-openui).
// From github.com/thesysdev/openui packages/lang-core/src/reactive.ts, MIT License, Copyright (c) Thesys Inc.
// ─────────────────────────────────────────────────────────────────────────────
// Reactive schema marker — shared between lang-core (introspection) and
// framework adapters (runtime binding).
// ─────────────────────────────────────────────────────────────────────────────

/** WeakSet tracks reactive schemas without mutating the schema objects. */
const reactiveSchemas = new WeakSet<object>();

/** Mark a schema as reactive. Called by framework adapters' reactive() function. */
export function markReactive(schema: object): void {
  reactiveSchemas.add(schema);
}

/** Check if a schema was marked reactive. Used by Zod introspection for $binding<> prefix. */
export function isReactiveSchema(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && reactiveSchemas.has(schema as object);
}
