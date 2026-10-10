/**
 * Renders a generative-UI widget spec (see widget.ts) natively — no WebView, no code
 * execution. Charts draw on Skia (already in the app) with a plain-View fallback when the
 * native module is absent. Deterministic and instant: the agent writes the spec, this paints it.
 */
import { useState } from "react";
import { View } from "react-native";
import { loadSkia } from "@/dictation/skia";
import { radii, spacing, tabularNumbers, type, useColors, type Colors } from "@/theme";
import { LinkButton } from "@/ui/LinkButton";
import { PageDots, PageStepper } from "@/ui/PageControls";
import { Pager, usePager } from "@/ui/Pager";
import { Pill, type PillProps } from "@/ui/Pill";
import { Text } from "@/ui/Text";
import { AudioPlayer } from "./AudioPlayer";
import { CompareSlider } from "./CompareSlider";
import { DiagramView } from "./DiagramView";
import { DiffView } from "./DiffView";
import { EmailList } from "./EmailList";
import { Gallery } from "./Gallery";
import { VideoPlayer } from "./VideoPlayer";
import type { BadgeSpec, CardSpec, ChartSpec, RowsSpec, StackSpec, StatSpec, TextSpec, TicketSpec, TicketsSpec, Tone, WidgetSpec } from "./widget";

const CHART_HEIGHT = 140;
const seriesColor = (colors: Colors, index: number, color?: string): string =>
  color ?? [colors.accent, colors.ok, colors.warn, colors.danger][index % 4] ?? colors.accent;

const frame = (colors: Colors) => ({ borderWidth: 1, borderColor: colors.hairline, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm }) as const;

/** Every widget sits in one hairline frame. A root card *is* that frame (no border inside a border);
 * cards nested deeper draw their own. */
export function Widget({ spec }: { spec: WidgetSpec }) {
  const colors = useColors();
  return <View style={frame(colors)}>{spec.widget === "card" ? <CardBody spec={spec} /> : <Node spec={spec} />}</View>;
}

function Node({ spec }: { spec: WidgetSpec }) {
  const colors = useColors();
  switch (spec.widget) {
    case "chart":
      return <Chart spec={spec} />;
    case "stat":
      return <Stat spec={spec} />;
    case "tickets":
      return <Tickets spec={spec} />;
    case "compare":
      return <CompareSlider spec={spec} />;
    case "audio":
      return <AudioPlayer spec={spec} />;
    case "video":
      return <VideoPlayer spec={spec} />;
    case "gallery":
      return <Gallery spec={spec} />;
    case "diagram":
      return <DiagramView spec={spec} />;
    case "text":
      return <TextBlock spec={spec} />;
    case "rows":
      return <Rows spec={spec} />;
    case "badge":
      return <Badge spec={spec} />;
    case "diff":
      return <DiffView spec={spec} />;
    case "emails":
      return <EmailList spec={spec} />;
    case "divider":
      return <View style={{ height: 1, backgroundColor: colors.hairline }} />;
    case "stack":
      return <Stack spec={spec} />;
    case "card":
      return (
        <View style={frame(colors)}>
          <CardBody spec={spec} />
        </View>
      );
  }
}

/** Horizontal children share the width equally, so stats or badges line up as columns. */
function Stack({ spec }: { spec: StackSpec }) {
  const row = spec.direction === "horizontal";
  return (
    <View style={{ flexDirection: row ? "row" : "column", gap: spacing[spec.gap ?? "sm"], alignItems: row ? "flex-start" : "stretch" }}>
      {spec.children.map((child, i) => (
        <View key={i} style={row ? { flex: 1, minWidth: 0 } : undefined}>
          <Node spec={child} />
        </View>
      ))}
    </View>
  );
}

function CardBody({ spec }: { spec: CardSpec }) {
  return (
    <>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      {spec.children.map((child, i) => (
        <Node key={i} spec={child} />
      ))}
    </>
  );
}

const textStyle = {
  heading: { variant: "title", color: "text" },
  body: { variant: "body", color: "text" },
  caption: { variant: "caption", color: "textMuted" },
  muted: { variant: "body", color: "textMuted" },
} as const;

function TextBlock({ spec }: { spec: TextSpec }) {
  const { variant, color } = textStyle[spec.style ?? "body"];
  return (
    <Text variant={variant} color={color}>
      {spec.text}
    </Text>
  );
}

const toneColor = { accent: "accent", ok: "ok", warn: "warn", danger: "danger", muted: "textMuted" } as const satisfies Record<
  Tone,
  NonNullable<PillProps["tone"]>
>;

/** Label left, value right, hairline between rows. A toned value colors only the value. */
function Rows({ spec }: { spec: RowsSpec }) {
  const colors = useColors();
  return (
    <View>
      {spec.rows.map((row, i) => (
        <View
          key={i}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: spacing.md,
            paddingVertical: spacing.sm,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: colors.hairline,
          }}
        >
          <Text variant="body" color="textMuted" style={{ flexShrink: 1 }}>
            {row.label}
          </Text>
          <Text variant="body" color={row.tone === undefined ? "text" : toneColor[row.tone]} tabular style={{ flexShrink: 1, textAlign: "right" }}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Badge({ spec }: { spec: BadgeSpec }) {
  return <Pill label={spec.label} tone={spec.tone === undefined ? "textMuted" : toneColor[spec.tone]} />;
}

const stateTone: Record<NonNullable<TicketSpec["stateType"]>, NonNullable<PillProps["tone"]>> = {
  triage: "warn",
  backlog: "textMuted",
  unstarted: "textMuted",
  started: "accent",
  completed: "ok",
  canceled: "danger",
};

/** Paged ticket summaries: swipe or tap the chevrons to move one card at a time. Pages are sized
 * to the measured width so snapping lands exactly on each card. */
function Tickets({ spec }: { spec: TicketsSpec }) {
  const [width, setWidth] = useState(0);
  const count = spec.tickets.length;
  const { page, setPage, go } = usePager(count);

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
          {spec.title ?? "Tickets"}
        </Text>
        <PageStepper page={page} count={count} onChange={go} />
      </View>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <Pager width={width} page={page} onPageChange={setPage}>
          {spec.tickets.map((ticket, i) => (
            <TicketCard key={`${ticket.id}-${i}`} ticket={ticket} />
          ))}
        </Pager>
      </View>
      <PageDots page={page} count={count} />
    </View>
  );
}

function TicketCard({ ticket }: { ticket: TicketSpec }) {
  const meta = [ticket.priority, ticket.assignee, ticket.updated].filter((part): part is string => part !== undefined && part !== "");
  const url = ticket.url;
  return (
    <View style={{ gap: spacing.sm, paddingRight: spacing.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="caption" color="textMuted" style={tabularNumbers}>
          {ticket.id}
        </Text>
        {ticket.state !== undefined && <Pill label={ticket.state} tone={ticket.stateType === undefined ? "textMuted" : stateTone[ticket.stateType]} />}
      </View>
      <Text variant="title">{ticket.title}</Text>
      <Text variant="body" color="textMuted">
        {ticket.summary}
      </Text>
      {meta.length > 0 && (
        <Text variant="caption" color="textFaint">
          {meta.join(" · ")}
        </Text>
      )}
      {url !== undefined && (
        <LinkButton url={url} label="Open in Linear" />
      )}
    </View>
  );
}

function Stat({ spec }: { spec: StatSpec }) {
  const colors = useColors();
  const dir = spec.delta?.direction;
  const deltaColor = dir === "up" ? colors.ok : dir === "down" ? colors.danger : colors.textMuted;
  const arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "→";
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="caption" color="textMuted">
        {spec.label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
        <Text variant="largeTitle">{spec.value}</Text>
        {spec.delta !== undefined && (
          <Text variant="label" style={{ color: deltaColor }}>
            {arrow} {spec.delta.value}
          </Text>
        )}
      </View>
    </View>
  );
}

function Chart({ spec }: { spec: ChartSpec }) {
  const [width, setWidth] = useState(0);
  const groups = Math.max(...spec.series.map((s) => s.points.length));
  const stacked = spec.kind === "bar" && spec.stacked === true;
  const max = stacked
    ? Math.max(1, ...Array.from({ length: groups }, (_, g) => spec.series.reduce((sum, s) => sum + (s.points[g] ?? 0), 0)))
    : Math.max(1, ...spec.series.flatMap((s) => s.points));

  return (
    <View style={{ gap: spacing.sm }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <View style={{ height: CHART_HEIGHT }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (spec.kind === "bar" ? <Bars spec={spec} width={width} max={max} /> : <Lines spec={spec} width={width} max={max} />)}
      </View>
      {spec.labels !== undefined && <AxisLabels labels={spec.labels} count={groups} width={width} />}
      {spec.series.length > 1 && <Legend spec={spec} />}
    </View>
  );
}

function Bars({ spec, width, max }: { spec: ChartSpec; width: number; max: number }) {
  const colors = useColors();
  const sk = loadSkia();
  const stacked = spec.stacked === true;
  const groups = Math.max(...spec.series.map((s) => s.points.length));
  const groupWidth = width / groups;
  const gap = groupWidth * 0.15;
  const barWidth = stacked ? groupWidth * 0.7 : (groupWidth * 0.7) / spec.series.length;

  const cum = new Array<number>(groups).fill(0);
  const rects = spec.series.flatMap((s, si) =>
    s.points.map((v, gi) => {
      const h = (v / max) * CHART_HEIGHT;
      const x = stacked ? gi * groupWidth + gap : gi * groupWidth + gap + si * barWidth;
      const y = stacked ? CHART_HEIGHT - cum[gi]! - h : CHART_HEIGHT - h;
      cum[gi]! += stacked ? h : 0;
      return { x, y, h, color: seriesColor(colors, si, s.color) };
    }),
  );

  if (sk === null) {
    return (
      <View style={{ flex: 1 }}>
        {rects.map((r, i) => (
          <View key={i} style={{ position: "absolute", left: r.x, top: r.y, width: barWidth, height: r.h, backgroundColor: r.color, borderRadius: 2 }} />
        ))}
      </View>
    );
  }

  const { Canvas, RoundedRect } = sk;
  return (
    <Canvas style={{ flex: 1 }}>
      {rects.map((r, i) => (
        <RoundedRect key={i} x={r.x} y={r.y} width={Math.max(1, barWidth - 2)} height={r.h} r={2} color={r.color} />
      ))}
    </Canvas>
  );
}

function Lines({ spec, width, max }: { spec: ChartSpec; width: number; max: number }) {
  const colors = useColors();
  const sk = loadSkia();
  if (sk === null) {
    // Without Skia, degrade a line chart to end-point dots so the data still reads.
    return (
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Text variant="caption" color="textMuted">
          {spec.series.map((s) => s.points.at(-1) ?? 0).join(" · ")}
        </Text>
      </View>
    );
  }

  const { Canvas, Path, Skia } = sk;
  const paths = spec.series.map((s, si) => {
    const path = Skia.Path.Make();
    const step = s.points.length > 1 ? width / (s.points.length - 1) : 0;
    s.points.forEach((v, i) => {
      const x = i * step;
      const y = CHART_HEIGHT - (v / max) * CHART_HEIGHT;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    return { path, color: seriesColor(colors, si, s.color) };
  });

  return (
    <Canvas style={{ flex: 1 }}>
      {paths.map((p, i) => (
        <Path key={i} path={p.path} color={p.color} style="stroke" strokeWidth={2} strokeCap="round" strokeJoin="round" />
      ))}
    </Canvas>
  );
}

function AxisLabels({ labels, count, width }: { labels: string[]; count: number; width: number }) {
  const slots = labels.slice(0, count);
  return (
    <View style={{ flexDirection: "row", width }}>
      {slots.map((label, i) => (
        <Text key={i} variant="caption" color="textMuted" style={{ flex: 1, textAlign: "center", fontSize: 10 }} numberOfLines={1}>
          {label}
        </Text>
      ))}
    </View>
  );
}

function Legend({ spec }: { spec: ChartSpec }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
      {spec.series.map((s, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: seriesColor(colors, i, s.color) }} />
          <Text variant="caption" color="textMuted">
            {s.name ?? `Series ${i + 1}`}
          </Text>
        </View>
      ))}
    </View>
  );
}
