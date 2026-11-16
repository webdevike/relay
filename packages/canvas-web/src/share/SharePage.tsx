// A shared board page (`/share/<token>` on the Relay host): read-only, nothing but the board or the
// one tab it was shared for. The host builds the data on every load (live tiles drawn with data
// from now) and embeds it; this draws it on a 12-column grid that stacks on a phone. Widget specs
// draw with the canvas's plain React widgets; Mantine tiles mount through the bundled Mantine
// runtime (`window.RelayWidget`, inlined by the host only when the page has one).
import { useEffect, useRef, useState } from "react";
import type { SharedBoard, SharedTile } from "../../../protocol/src/index";
import { WidgetView } from "../widget";

export type Scheme = "light" | "dark";

interface MountOptions {
  source: string;
  config: unknown;
  colorScheme: Scheme;
}

declare global {
  interface Window {
    RelayWidget?: { mount: (element: HTMLElement, options: MountOptions) => void };
  }
}

/** "Nov 16, 3:04 PM" in the viewer's time, or the stamp as written when it is not a date. */
function stamp(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value
    : at.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** A Mantine tile: mounted once into its box (tabs hide, never unmount, so it is never drawn twice). */
function MantineTile({
  tile,
  config,
  scheme,
}: {
  tile: SharedTile;
  config: unknown;
  scheme: Scheme;
}) {
  const box = useRef<HTMLDivElement>(null);
  const source = tile.mantine ?? "";
  useEffect(() => {
    const el = box.current;
    if (el !== null && window.RelayWidget !== undefined)
      window.RelayWidget.mount(el, { source, config, colorScheme: scheme });
  }, [source, config, scheme]);
  return (
    <div
      className="sh-mantine"
      data-fixed={tile.height === undefined ? undefined : "true"}
      style={tile.height === undefined ? undefined : { height: tile.height }}
    >
      <div className="sh-mantine-root" ref={box} />
    </div>
  );
}

export function SharePage({ board, scheme }: { board: SharedBoard; scheme: Scheme }) {
  const [shown, setShown] = useState(board.tabs[0]?.id ?? "");
  return (
    <main className="sh-page">
      <header className="sh-head">
        <h1 className="sh-title">{board.tab ?? board.title}</h1>
        <div className="sh-caption">
          {board.tab === null ? "" : `${board.title} · `}Updated {stamp(board.updatedAt)}
        </div>
      </header>
      {board.tabs.length > 1 ? (
        <nav className="sh-tabs" role="tablist">
          {board.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="sh-tab"
              aria-selected={tab.id === shown}
              onClick={() => setShown(tab.id)}
            >
              {tab.title}
            </button>
          ))}
        </nav>
      ) : null}
      {board.tabs.map((tab) => (
        <section key={tab.id} className="sh-grid" hidden={tab.id !== shown} data-tab={tab.id}>
          {tab.widgets.length === 0 ? <p className="sh-empty">Nothing here yet.</p> : null}
          {tab.widgets.map((tile) => (
            <div
              key={tile.id}
              className="sh-tile"
              data-tile={tile.id}
              style={{ gridColumn: `span ${tile.span}` }}
            >
              {tile.mantine === undefined ? (
                <WidgetView spec={tile.spec} />
              ) : (
                <MantineTile tile={tile} config={board.mantineConfig} scheme={scheme} />
              )}
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
