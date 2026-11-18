/**
 * The Mantine widget runtime: the entry `build.ts` bundles (with React, Mantine, @mantine/charts,
 * @mantine/hooks and Sucrase) into one offline script for the widget page (`frame.ts`
 * `mantineFrameDocument`, `protoFrameDocument`). It exposes `window.RelayWidget.mount(element, {
 * source, config, colorScheme, system? })`, which compiles the agent's JSX and renders it in a
 * `MantineProvider`: with the shared theme `config`, or, for a prototype, the design `system`'s
 * theme and components. A compile or render error shows a small Mantine Alert in place of the widget.
 *
 * A `live` page (a canvas component card on desktop) also takes new source from its host without
 * reloading (`{type: "source", source, rev}` posted by the parent window): each revision compiles
 * and renders in place, and one that does not compile or throws while rendering leaves the last
 * good render on screen. The page answers every revision with `{type: "render", rev, ok, error?}`
 * and reports its content's size (`{type: "content", w, h}`), which the card's frame clips.
 */
import * as React from "react";
import { Component, type ErrorInfo, type FunctionComponent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Alert, MantineProvider, type MantineColorSchemeManager } from "@mantine/core";
import type { DesignSystem } from "../systems";
import { cssVariablesFor, themeOverrideFor, type ColorScheme, type ThemeConfig } from "../theme";
import { compileWidget } from "./compile";
import { widgetScope } from "./scope";
import { setKitAssistants, type KitAssistant } from "./relay-kit";
import { systemTheme } from "./systems";

export interface MountOptions {
  source: string;
  config: ThemeConfig;
  colorScheme: ColorScheme;
  /** A prototype's design system: its theme and components replace `config`. */
  system?: DesignSystem | undefined;
  /**
   * The `relay` system as the host runs it (Relay Desktop's Settings > Theme), in place of the
   * snapshot in systems/relay.ts.
   */
  systemConfig?: ThemeConfig | undefined;
  /** Take new source from the parent window and keep the last good render (see above). */
  live?: boolean | undefined;
  /** The assistant registry for the `relay` kit's `agent` props (relay-kit.tsx). */
  assistants?: Readonly<Record<string, KitAssistant>> | undefined;
}

/** What a live page answers for each revision of its source. */
export interface RenderReport {
  rev: number;
  ok: boolean;
  error?: string;
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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function ErrorAlert({ error }: { error: unknown }) {
  return (
    <Alert color="red" variant="light" title="Widget error" radius="md">
      {messageOf(error)}
    </Alert>
  );
}

class WidgetBoundary extends Component<
  { children: ReactNode; onError?: ((error: unknown) => void) | undefined },
  { error: unknown }
> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("mantine-widget", error, info.componentStack);
    this.props.onError?.(error);
  }

  override render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <ErrorAlert error={this.state.error} />
    );
  }
}

/** The Mantine provider a widget draws in: the shared theme, or its design system's. */
function Themed({
  config,
  colorScheme,
  system,
  systemConfig,
  children,
}: Omit<MountOptions, "source" | "live"> & { children: ReactNode }) {
  const { theme, resolver } = React.useMemo(
    () =>
      system === undefined
        ? { theme: themeOverrideFor(config), resolver: () => cssVariablesFor(config) }
        : systemTheme(system, systemConfig),
    [config, system, systemConfig],
  );
  const manager = React.useMemo(() => fixedScheme(colorScheme), [colorScheme]);
  return (
    <MantineProvider
      theme={theme}
      {...(resolver === undefined ? {} : { cssVariablesResolver: resolver })}
      colorSchemeManager={manager}
      forceColorScheme={colorScheme}
    >
      {children}
    </MantineProvider>
  );
}

export function WidgetRoot({ source, ...theme }: MountOptions) {
  const { system } = theme;
  const compiled = React.useMemo(() => {
    try {
      return { Widget: compileWidget(source, widgetScope(system)), error: null };
    } catch (error) {
      return { Widget: null, error };
    }
  }, [source, system]);
  return (
    <Themed {...theme}>
      {compiled.Widget === null ? (
        <ErrorAlert error={compiled.error} />
      ) : (
        <WidgetBoundary>
          <compiled.Widget />
        </WidgetBoundary>
      )}
    </Themed>
  );
}

interface Revision {
  rev: number;
  Widget: FunctionComponent;
}

/** Runs `onCommit` once its revision rendered and committed without throwing. */
function Committed({ onCommit }: { onCommit: () => void }) {
  React.useEffect(onCommit, [onCommit]);
  return null;
}

/** Where a live page hears new source: the host calls `push`; `listen` subscribes the root. */
export interface SourceFeed {
  listen(apply: (source: string, rev: number) => void): () => void;
}

/**
 * A live page's root. Each revision compiles; one that compiles renders in place of the shown one
 * and becomes the good one once it committed. A revision that does not compile, or throws while
 * rendering, is reported and the good one stays. With no good revision yet, the error shows.
 */
export function LiveRoot({
  source,
  feed,
  report,
  ...theme
}: Omit<MountOptions, "live"> & { feed: SourceFeed; report: (r: RenderReport) => void }) {
  const { system } = theme;
  const compile = React.useCallback(
    (code: string, rev: number): Revision | { rev: number; error: string } => {
      try {
        return { rev, Widget: compileWidget(code, widgetScope(system)) };
      } catch (error) {
        return { rev, error: messageOf(error) };
      }
    },
    [system],
  );
  const [view, setView] = React.useState<{
    good: Revision | null;
    next: Revision | null;
    error: string | null;
  }>(() => {
    const first = compile(source, 0);
    return "Widget" in first
      ? { good: null, next: first, error: null }
      : { good: null, next: null, error: first.error };
  });
  // The first revision's compile error is reported once the page is up.
  const reportRef = React.useRef(report);
  reportRef.current = report;
  const firstError = React.useRef(view.error);
  React.useEffect(() => {
    if (firstError.current !== null)
      reportRef.current({ rev: 0, ok: false, error: firstError.current });
  }, []);

  React.useEffect(
    () =>
      feed.listen((code, rev) => {
        const r = compile(code, rev);
        if ("Widget" in r) {
          setView((v) => ({ ...v, next: r }));
        } else {
          reportRef.current({ rev, ok: false, error: r.error });
          setView((v) => (v.good === null ? { good: null, next: null, error: r.error } : v));
        }
      }),
    [feed, compile],
  );

  const shown = view.next ?? view.good;
  const committed = React.useCallback(() => {
    setView((v) => {
      if (v.next === null) return v;
      reportRef.current({ rev: v.next.rev, ok: true });
      return { good: v.next, next: null, error: null };
    });
  }, []);
  const failed = React.useCallback((error: unknown) => {
    setView((v) => {
      if (v.next === null) return v;
      reportRef.current({ rev: v.next.rev, ok: false, error: messageOf(error) });
      return v.good === null
        ? { good: null, next: null, error: messageOf(error) }
        : { ...v, next: null };
    });
  }, []);

  return (
    <Themed {...theme}>
      {shown === null ? (
        <ErrorAlert error={view.error ?? "Nothing to show yet"} />
      ) : (
        <WidgetBoundary key={shown.rev} onError={shown === view.next ? failed : undefined}>
          <shown.Widget />
          {shown === view.next ? <Committed onCommit={committed} /> : null}
        </WidgetBoundary>
      )}
    </Themed>
  );
}

/** Posts a JSON message to the desktop host (live pages run only in Relay Desktop's frames). */
function post(message: object): void {
  if (window.parent !== window) window.parent.postMessage(JSON.stringify(message), "*");
}

/** New source the parent window posts: `{type: "source", source, rev}` as a JSON string. */
function parentFeed(): SourceFeed {
  return {
    listen(apply) {
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window.parent || typeof event.data !== "string") return;
        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof value !== "object" || value === null) return;
        const m = value as Record<string, unknown>;
        if (m["type"] !== "source" || typeof m["source"] !== "string") return;
        if (typeof m["rev"] !== "number" || !Number.isInteger(m["rev"])) return;
        apply(m["source"], m["rev"]);
      };
      window.addEventListener("message", onMessage);
      return () => {
        window.removeEventListener("message", onMessage);
      };
    },
  };
}

/** Reports the page's content size to the host whenever it changes (the card's frame clips it). */
function reportContentSize(): void {
  const doc = document.documentElement;
  let last = "";
  const send = (): void => {
    const size = { w: doc.scrollWidth, h: doc.scrollHeight };
    const key = `${String(size.w)}x${String(size.h)}`;
    if (key === last) return;
    last = key;
    post({ type: "content", ...size });
  };
  const observer = new ResizeObserver(send);
  observer.observe(doc);
  observer.observe(document.body);
  // Content that grows inside a fixed-height body resizes neither: watch the tree too.
  new MutationObserver(send).observe(document.body, { childList: true, subtree: true });
  send();
}

if (typeof window !== "undefined") {
  window.RelayWidget = {
    mount(element, { live, assistants, ...options }) {
      if (assistants !== undefined) setKitAssistants(assistants);
      createRoot(element).render(
        live === true ? (
          <LiveRoot
            {...options}
            feed={parentFeed()}
            report={(r) => {
              post({ type: "render", ...r });
            }}
          />
        ) : (
          <WidgetRoot {...options} />
        ),
      );
      if (live === true) reportContentSize();
    },
  };
}
