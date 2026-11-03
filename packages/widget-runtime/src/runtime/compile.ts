/**
 * Turns a ```mantine-widget fence into a React component. The fence is the body of a function
 * component (hooks and constants, then `return <.../>`), or a single JSX element. `import` lines are
 * dropped (everything is already in scope) and an `export default` component is accepted too, so
 * code written as a module still runs. Sucrase strips TypeScript and compiles JSX to
 * `React.createElement`; the result is evaluated with every scope name as a parameter, so the
 * widget sees Mantine, @mantine/charts, @mantine/hooks, React's hooks and `relay` as plain names.
 */
import { transform } from "sucrase";
import type { FunctionComponent } from "react";

const IMPORT_LINE = /^\s*import\s[^;\n]*?(?:from\s*)?["'][^"'\n]+["'];?[ \t]*$/gm;
const EXPORT_DEFAULT = /\bexport\s+default\s+/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The factory's source: a function returning the widget component, before compilation. */
export function widgetFactorySource(source: string): string {
  const code = source.replace(IMPORT_LINE, "").trim();
  if (EXPORT_DEFAULT.test(code))
    return `function __widget__() {\n${code.replace(EXPORT_DEFAULT, "return ")}\n}`;
  const body = code.startsWith("<") ? `return (${code});` : code;
  return `function __widget__() {\nreturn function Widget() {\n${body}\n};\n}`;
}

function transformWidget(source: string): string {
  return transform(widgetFactorySource(source), {
    transforms: ["jsx", "typescript"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    production: true,
  }).code;
}

/** Compiles `source` with `scope` names in reach; throws a SyntaxError-like Error on bad code. */
export function compileWidget(source: string, scope: Record<string, unknown>): FunctionComponent {
  const code = transformWidget(source);
  const names = Object.keys(scope).filter((name) => IDENTIFIER.test(name));
  // The widget's code is the agent's own: evaluating it is the point. The page's CSP keeps it offline.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(...names, `"use strict";\n${code}\nreturn __widget__();`) as (
    ...values: unknown[]
  ) => unknown;
  const component = factory(...names.map((name) => scope[name]));
  if (typeof component !== "function")
    throw new Error("The widget must return JSX or export a component.");
  return component as FunctionComponent;
}

const ELEMENT = /React\.createElement\(\s*([A-Za-z_$][\w$]*)/g;

/**
 * Why `source` would not draw, without running it: it does not parse (JSX or TypeScript), or it
 * uses a component that is neither in `known` (the scope's names, generated/scope.ts) nor defined
 * in the code itself. Null when it compiles. A name counts as defined when it appears anywhere in
 * the compiled code other than as an element type (its declaration, a parameter, an import alias).
 */
export function checkWidgetSource(source: string, known: ReadonlySet<string>): string | null {
  let code: string;
  try {
    code = transformWidget(source);
    // Parses the compiled JS without running it.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(code);
  } catch (error) {
    return `does not compile: ${error instanceof Error ? error.message : String(error)}`;
  }
  const asElement = new Map<string, number>();
  for (const m of code.matchAll(ELEMENT)) {
    const name = m[1] ?? "";
    asElement.set(name, (asElement.get(name) ?? 0) + 1);
  }
  const unknown: string[] = [];
  for (const [name, uses] of asElement) {
    if (known.has(name)) continue;
    const all =
      code.match(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g"))?.length ??
      0;
    if (all <= uses) unknown.push(name);
  }
  return unknown.length === 0
    ? null
    : `unknown component${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `<${n}>`).join(", ")}: not in Mantine, @mantine/charts or the design system, and not defined in the code`;
}
