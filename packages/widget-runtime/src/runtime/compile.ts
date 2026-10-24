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

/** Compiles `source` with `scope` names in reach; throws a SyntaxError-like Error on bad code. */
export function compileWidget(source: string, scope: Record<string, unknown>): FunctionComponent {
  const { code } = transform(widgetFactorySource(source), {
    transforms: ["jsx", "typescript"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    production: true,
  });
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
