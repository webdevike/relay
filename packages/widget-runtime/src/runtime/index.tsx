/**
 * The Mantine widget runtime: the entry `build.ts` bundles (with React, Mantine, @mantine/charts,
 * @mantine/hooks and Sucrase) into one offline script for the widget page (`frame.ts`
 * `mantineFrameDocument`, `protoFrameDocument`). It exposes `window.RelayWidget.mount(element, {
 * source, config, colorScheme, system? })`, which compiles the agent's JSX and renders it in a
 * `MantineProvider`: with the shared theme `config`, or, for a prototype, the design `system`'s
 * theme and components. A compile or render error shows a small Mantine Alert in place of the widget.
 */
import * as React from "react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Alert, MantineProvider, type MantineColorSchemeManager } from "@mantine/core";
import type { DesignSystem } from "../systems";
import { cssVariablesFor, themeOverrideFor, type ColorScheme, type ThemeConfig } from "../theme";
import { compileWidget } from "./compile";
import { widgetScope } from "./scope";
import { systemTheme } from "./systems";

export interface MountOptions {
  source: string;
  config: ThemeConfig;
  colorScheme: ColorScheme;
  /** A prototype's design system: its theme and components replace `config`. */
  system?: DesignSystem | undefined;
}

/** `window.relay` from the page's bridge script (`frame.ts`). */
declare global {
  interface Window {
    relay?: unknown;
    RelayWidget?: { mount: (element: HTMLElement, options: MountOptions) => void };
  }
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

export function WidgetRoot({ source, config, colorScheme, system }: MountOptions) {
  const { theme, resolver } = React.useMemo(
    () =>
      system === undefined
        ? { theme: themeOverrideFor(config), resolver: () => cssVariablesFor(config) }
        : systemTheme(system),
    [config, system],
  );
  const manager = React.useMemo(() => fixedScheme(colorScheme), [colorScheme]);
  const compiled = React.useMemo(() => {
    try {
      return { Widget: compileWidget(source, widgetScope(system)), error: null };
    } catch (error) {
      return { Widget: null, error };
    }
  }, [source, system]);
  return (
    <MantineProvider
      theme={theme}
      {...(resolver === undefined ? {} : { cssVariablesResolver: resolver })}
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
