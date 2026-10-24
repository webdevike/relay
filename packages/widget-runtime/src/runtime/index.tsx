/**
 * The Mantine widget runtime: the entry `build.ts` bundles (with React, Mantine, @mantine/charts,
 * @mantine/hooks and Sucrase) into one offline script for the widget page (`frame.ts`
 * `mantineFrameDocument`). It exposes `window.RelayWidget.mount(element, { source, config,
 * colorScheme })`, which compiles the agent's JSX and renders it in a `MantineProvider` with the
 * shared theme. A compile or render error shows a small Mantine Alert in place of the widget.
 */
import * as React from "react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as MantineCharts from "@mantine/charts";
import * as MantineCore from "@mantine/core";
import * as MantineHooks from "@mantine/hooks";
import { Alert, MantineProvider, type MantineColorSchemeManager } from "@mantine/core";
import { cssVariablesFor, themeOverrideFor, type ColorScheme, type ThemeConfig } from "../theme";
import { compileWidget } from "./compile";

export interface MountOptions {
  source: string;
  config: ThemeConfig;
  colorScheme: ColorScheme;
}

/** `window.relay` from the page's bridge script (`frame.ts`). */
declare global {
  interface Window {
    relay?: unknown;
    RelayWidget?: { mount: (element: HTMLElement, options: MountOptions) => void };
  }
}

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

function widgetScope(): Record<string, unknown> {
  const scope: Record<string, unknown> = { ...MantineHooks, ...MantineCore, ...MantineCharts };
  for (const name of REACT_NAMES) scope[name] = React[name];
  scope["React"] = React;
  scope["relay"] = typeof window === "undefined" ? undefined : window.relay;
  return scope;
}

/**
 * The page is sandboxed (on desktop an opaque-origin iframe where storage throws), so the scheme
 * comes from the host and nothing is stored.
 */
function fixedScheme(colorScheme: ColorScheme): MantineColorSchemeManager {
  return {
    get: () => colorScheme,
    set: () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    clear: () => undefined,
  };
}

function ErrorAlert({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Alert color="red" variant="light" title="Widget error" radius="md">
      {message}
    </Alert>
  );
}

class WidgetBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("mantine-widget", error, info.componentStack);
  }

  override render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <ErrorAlert error={this.state.error} />
    );
  }
}

export function WidgetRoot({ source, config, colorScheme }: MountOptions) {
  const theme = React.useMemo(() => themeOverrideFor(config), [config]);
  const resolver = React.useMemo(() => () => cssVariablesFor(config), [config]);
  const manager = React.useMemo(() => fixedScheme(colorScheme), [colorScheme]);
  const compiled = React.useMemo(() => {
    try {
      return { Widget: compileWidget(source, widgetScope()), error: null };
    } catch (error) {
      return { Widget: null, error };
    }
  }, [source]);
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={resolver}
      colorSchemeManager={manager}
      forceColorScheme={colorScheme}
    >
      {compiled.Widget === null ? (
        <ErrorAlert error={compiled.error} />
      ) : (
        <WidgetBoundary>
          <compiled.Widget />
        </WidgetBoundary>
      )}
    </MantineProvider>
  );
}

if (typeof window !== "undefined") {
  window.RelayWidget = {
    mount(element, options) {
      createRoot(element).render(<WidgetRoot {...options} />);
    },
  };
}
