// A live `ui` node's widget: its OpenUI Lang source run by the protocol's runtime (Query data from
// the host's token-gated `/canvas/<slug>/query`, refreshing while the card is on the board; buttons
// and inputs run locally), drawn with plain React in this page's look. Desktop and the phone draw
// the same widget tree with their own renderers; this one covers the layout and data widgets live
// widgets use, and names the rest (media, PRs, inboxes) instead of drawing them.
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createOpenUIRuntime,
  type OpenUIQueryClient,
  type OpenUIRuntime,
} from "../../protocol/src/openui/index";
import type { ChartSpec, Tone, WidgetSpec } from "../../protocol/src/widget";
import { type PageEnv, roomUrl } from "./env";

/** Runs a Query through the room's `query` route; rejects with the host's reason. */
export function roomQueryClient(env: PageEnv): OpenUIQueryClient {
  return {
    async run(tool, args) {
      const res = await fetch(roomUrl(env, "query"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, args }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: unknown;
        data?: unknown;
        error?: unknown;
      } | null;
      if (body?.ok === true) return body.data;
      throw new Error(
        typeof body?.error === "string" ? body.error : `the host answered ${String(res.status)}`,
      );
    },
  };
}

const Runtime = createContext<OpenUIRuntime | null>(null);

/** One live widget: its own runtime while mounted; a new source replaces the program, keeping `$variables`. */
export function LiveWidget({
  source,
  query,
  onReady,
}: {
  source: string;
  query: OpenUIQueryClient;
  /** Called once the widget has drawn (or shows its error): the card can leave its skeleton. */
  onReady?: () => void;
}) {
  const [runtime] = useState(() => createOpenUIRuntime(source, { query }));
  useEffect(() => runtime.update(source), [runtime, source]);
  const snap = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const issue =
    snap.errors.find((e) => e.code === "query-error") ??
    (snap.node === null ? snap.errors[0] : undefined);
  const drawn = snap.node !== null || issue !== undefined;
  useEffect(() => {
    if (drawn) onReady?.();
  }, [drawn, onReady]);
  return (
    <Runtime.Provider value={runtime}>
      {snap.node !== null ? <Node spec={snap.node} /> : <pre className="cv-w-source">{source}</pre>}
      {issue ? (
        <div className="cv-w-issue" title={issue.message}>
          {issue.message}
        </div>
      ) : null}
    </Runtime.Provider>
  );
}

function Children({ nodes }: { nodes: readonly WidgetSpec[] }) {
  return nodes.map((n, i) => <Node key={i} spec={n} />);
}

function Chart({ spec }: { spec: ChartSpec }) {
  const width = 300;
  const height = 120;
  const count = Math.max(...spec.series.map((s) => s.points.length));
  const max = Math.max(1, ...spec.series.flatMap((s) => s.points));
  const step = width / Math.max(1, count);
  return (
    <div className="cv-w-chart">
      {spec.title ? <div className="cv-w-caption">{spec.title}</div> : null}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={spec.title ?? "chart"}
      >
        {spec.series.map((s, si) =>
          spec.kind === "bar" ? (
            s.points.map((p, i) => {
              const bw = step / spec.series.length - 2;
              const h = (Math.max(0, p) / max) * (height - 4);
              return (
                <rect
                  key={`${si}-${i}`}
                  x={i * step + si * (bw + 2) + 1}
                  y={height - h}
                  width={Math.max(1, bw)}
                  height={h}
                  rx={2}
                  className="cv-w-bar"
                  data-series={si}
                />
              );
            })
          ) : (
            <polyline
              key={si}
              fill="none"
              className="cv-w-line"
              data-series={si}
              points={s.points
                .map((p, i) => `${i * step + step / 2},${height - (p / max) * (height - 4)}`)
                .join(" ")}
            />
          ),
        )}
      </svg>
      {spec.labels ? (
        <div className="cv-w-chart-labels">
          {spec.labels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Tabs({ tabs }: { tabs: { label: string; children: WidgetSpec[] }[] }) {
  const [at, setAt] = useState(0);
  const shown = tabs[Math.min(at, tabs.length - 1)];
  return (
    <div className="cv-w-tabs">
      <div className="cv-w-tabbar" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === at}
            className="cv-w-tab"
            onClick={() => setAt(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {shown ? <Children nodes={shown.children} /> : null}
    </div>
  );
}

function Collapse({ title, open, nodes }: { title: string; open: boolean; nodes: WidgetSpec[] }) {
  const [shown, setShown] = useState(open);
  return (
    <div className="cv-w-collapse">
      <button
        type="button"
        className="cv-w-collapse-head"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        <span>{shown ? "▾" : "▸"}</span> {title}
      </button>
      {shown ? <Children nodes={nodes} /> : null}
    </div>
  );
}

function Button({
  label,
  variant,
  tone,
  url,
  action,
  reply,
}: {
  label: string;
  variant: string;
  tone?: Tone | undefined;
  url?: string | undefined;
  action?: string | undefined;
  reply?: string | undefined;
}) {
  const runtime = useContext(Runtime);
  // No chat thread behind a board: a reply button stays disabled.
  const disabled = action === undefined && url === undefined;
  return (
    <button
      type="button"
      className="cv-w-button"
      data-variant={variant}
      data-tone={tone}
      disabled={disabled}
      title={reply !== undefined ? "Replies run in a chat, not on the board" : undefined}
      onClick={() => {
        if (action !== undefined && runtime) {
          const out = runtime.dispatch(action);
          if (out.url) window.open(out.url, "_blank", "noopener");
        } else if (url !== undefined) window.open(url, "_blank", "noopener");
      }}
    >
      {label}
    </button>
  );
}

function Input({
  placeholder,
  bind,
  value,
  multiline,
}: {
  placeholder?: string | undefined;
  bind?: string | undefined;
  value?: string | undefined;
  multiline?: boolean | undefined;
}) {
  const runtime = useContext(Runtime);
  if (bind === undefined || !runtime)
    return <input className="cv-w-input" placeholder={placeholder} disabled />;
  const props = {
    className: "cv-w-input",
    placeholder,
    value: value ?? "",
    onChange: (e: { currentTarget: { value: string } }) =>
      runtime.setInput(bind, e.currentTarget.value),
  };
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
}

function Node({ spec }: { spec: WidgetSpec }): ReactNode {
  switch (spec.widget) {
    case "stack":
      return (
        <div
          className="cv-w-stack"
          data-dir={spec.direction ?? "vertical"}
          data-gap={spec.gap ?? "sm"}
        >
          <Children nodes={spec.children} />
        </div>
      );
    case "card":
      return (
        <div className="cv-w-card">
          {spec.title ? <div className="cv-w-heading">{spec.title}</div> : null}
          <Children nodes={spec.children} />
        </div>
      );
    case "grid":
      return (
        <div
          className="cv-w-grid"
          data-gap={spec.gap ?? "sm"}
          style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}
        >
          <Children nodes={spec.children} />
        </div>
      );
    case "tabs":
      return <Tabs tabs={spec.tabs} />;
    case "collapse":
      return <Collapse title={spec.title} open={spec.open} nodes={spec.children} />;
    case "text":
      return (
        <div
          className="cv-w-text"
          data-style={spec.style ?? "body"}
          style={spec.align ? { textAlign: spec.align } : undefined}
        >
          {spec.text}
        </div>
      );
    case "stat":
      return (
        <div className="cv-w-stat">
          <div className="cv-w-caption">{spec.label}</div>
          <div className="cv-w-stat-value">{spec.value}</div>
          {spec.delta ? (
            <div className="cv-w-caption" data-dir={spec.delta.direction}>
              {spec.delta.direction === "up" ? "▲ " : spec.delta.direction === "down" ? "▼ " : ""}
              {spec.delta.value}
            </div>
          ) : null}
        </div>
      );
    case "rows":
      return (
        <div className="cv-w-rows">
          {spec.rows.map((r, i) => (
            <div key={i} className="cv-w-row">
              <span>{r.label}</span>
              <span className="cv-w-row-value" data-tone={r.tone}>
                {r.value}
              </span>
            </div>
          ))}
        </div>
      );
    case "badge":
      return (
        <span className="cv-w-badge" data-tone={spec.tone}>
          {spec.label}
        </span>
      );
    case "divider":
      return <hr className="cv-w-divider" />;
    case "button":
      return (
        <Button
          label={spec.label}
          variant={spec.variant}
          tone={spec.tone}
          url={spec.url}
          action={spec.action}
          reply={spec.reply}
        />
      );
    case "link":
      return (
        <a className="cv-w-link" href={spec.url} target="_blank" rel="noreferrer">
          {spec.label}
        </a>
      );
    case "input":
      return (
        <Input
          placeholder={spec.placeholder}
          bind={spec.bind}
          value={spec.value}
          multiline={spec.multiline}
        />
      );
    case "table":
      return (
        <div className="cv-w-table-wrap">
          {spec.title ? <div className="cv-w-caption">{spec.title}</div> : null}
          <table className="cv-w-table">
            <thead>
              <tr>
                {spec.columns.map((c, i) => (
                  <th
                    key={i}
                    style={typeof c === "object" && c.align ? { textAlign: c.align } : undefined}
                  >
                    {typeof c === "string" ? c : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => {
                    const col = spec.columns[ci];
                    const style =
                      typeof col === "object" && col.align ? { textAlign: col.align } : undefined;
                    const tone = typeof cell === "object" ? cell.tone : undefined;
                    const url = typeof cell === "object" ? cell.url : undefined;
                    const text = typeof cell === "object" ? cell.text : String(cell);
                    return (
                      <td
                        key={ci}
                        style={style}
                        data-tone={tone}
                        data-bold={typeof cell === "object" && cell.bold ? "true" : undefined}
                      >
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer">
                            {text}
                          </a>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "progress":
      return (
        <div className="cv-w-progress">
          {spec.label ? <div className="cv-w-caption">{spec.label}</div> : null}
          <div className="cv-w-progress-track">
            <div
              className="cv-w-progress-bar"
              data-tone={spec.tone}
              style={{ width: `${(spec.value / spec.max) * 100}%` }}
            />
          </div>
          {spec.caption ? <div className="cv-w-caption">{spec.caption}</div> : null}
        </div>
      );
    case "list": {
      const Tag = spec.style === "number" ? "ol" : "ul";
      return (
        <Tag className="cv-w-list" data-style={spec.style}>
          {spec.items.map((raw, i) => {
            const item =
              typeof raw === "string" ? { text: raw, caption: undefined, checked: undefined } : raw;
            return (
              <li
                key={i}
                data-checked={spec.style === "check" ? String(item.checked === true) : undefined}
              >
                {item.text}
                {item.caption ? <div className="cv-w-caption">{item.caption}</div> : null}
              </li>
            );
          })}
        </Tag>
      );
    }
    case "callout":
      return (
        <div className="cv-w-callout" data-tone={spec.tone}>
          {spec.title ? <div className="cv-w-heading">{spec.title}</div> : null}
          <div>{spec.text}</div>
        </div>
      );
    case "quote":
      return (
        <blockquote className="cv-w-quote">
          {spec.text}
          {spec.cite ? <div className="cv-w-caption">{spec.cite}</div> : null}
        </blockquote>
      );
    case "code":
      return <pre className="cv-w-source">{spec.code}</pre>;
    case "avatar":
      return (
        <div className="cv-w-avatar">
          <span className="cv-w-initials">
            {spec.name
              .split(/\s+/)
              .map((w) => w[0] ?? "")
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <span>
            <div className="cv-w-heading">{spec.name}</div>
            {spec.subtitle ? <div className="cv-w-caption">{spec.subtitle}</div> : null}
          </span>
        </div>
      );
    case "timeline":
      return (
        <div className="cv-w-timeline">
          {spec.items.map((e, i) => (
            <div key={i} className="cv-w-timeline-item" data-tone={e.tone}>
              <div className="cv-w-heading">
                {e.title}
                {e.time ? <span className="cv-w-caption"> {e.time}</span> : null}
              </div>
              {e.text ? <div className="cv-w-caption">{e.text}</div> : null}
            </div>
          ))}
        </div>
      );
    case "chart":
      return <Chart spec={spec} />;
    case "image":
      return /^https?:\/\//.test(spec.src) ? (
        <img className="cv-w-image" src={spec.src} alt={spec.alt ?? ""} />
      ) : (
        <Unsupported kind="image" />
      );
    default:
      return <Unsupported kind={spec.widget} />;
  }
}

/** Media, PRs, inboxes and the like: named, not drawn, on the canvas. */
function Unsupported({ kind }: { kind: string }) {
  return (
    <div className="cv-w-caption">{`${kind} widget (open it in Relay Desktop or the phone)`}</div>
  );
}
