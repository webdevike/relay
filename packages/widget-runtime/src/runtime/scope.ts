/**
 * What a widget's code sees as plain names: every @mantine/core, @mantine/charts and @mantine/hooks
 * export, React's hooks and helpers, `React`, `relay`, and the design system's own components.
 * build.ts writes the names to generated/scope.ts, so the host can refuse an unknown component
 * without loading Mantine.
 */
import * as React from "react";
import * as MantineCharts from "@mantine/charts";
import * as MantineCore from "@mantine/core";
import * as MantineHooks from "@mantine/hooks";
import type { DesignSystem } from "../systems";
import { systemScope } from "./systems";

/** React's own hooks and helpers by name, as a widget writes them without `React.`. */
const REACT_NAMES = [
  "Fragment",
  "useActionState",
  "useCallback",
  "useDeferredValue",
  "useEffect",
  "useId",
  "useLayoutEffect",
  "useMemo",
  "useOptimistic",
  "useReducer",
  "useRef",
  "useState",
  "useTransition",
] as const;

export function widgetScope(system?: DesignSystem): Record<string, unknown> {
  const scope: Record<string, unknown> = { ...MantineHooks, ...MantineCore, ...MantineCharts };
  for (const name of REACT_NAMES) scope[name] = React[name];
  scope["React"] = React;
  scope["relay"] = typeof window === "undefined" ? undefined : window.relay;
  return { ...scope, ...systemScope(system) };
}
