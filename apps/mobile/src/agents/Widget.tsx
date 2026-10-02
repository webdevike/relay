/**
 * Renders a generative-UI widget spec (see widget.ts) natively — no WebView, no code
 * execution. Charts draw on Skia (already in the app) with a plain-View fallback when the
 * native module is absent. Deterministic and instant: the agent writes the spec, this paints it.
 */
import { useRef, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { loadSkia } from "@/dictation/skia";
import { tapHaptic } from "@/lib/haptics";
import { colors, radii, spacing, tabularNumbers, type } from "@/theme";
import { Pill, type PillProps } from "@/ui/Pill";
import { Text } from "@/ui/Text";
import type { ChartSpec, StatSpec, TicketSpec, TicketsSpec, WidgetSpec } from "./widget";

const CHART_HEIGHT = 140;
const PALETTE = [colors.accent, colors.ok, colors.warn, colors.danger];
const seriesColor = (index: number, color?: string): string => color ?? PALETTE[index % PALETTE.length] ?? colors.accent;

export function Widget({ spec }: { spec: WidgetSpec }) {
  return (
    <View style={{ borderWidth: 1, borderColor: colors.hairline, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm }}>
      {spec.widget === "chart" ? <Chart spec={spec} /> : spec.widget === "stat" ? <Stat spec={spec} /> : <Tickets spec={spec} />}
    </View>
  );
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
  const scroller = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const count = spec.tickets.length;

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(count - 1, next));
    if (clamped === page) return;
    tapHaptic();
    setPage(clamped);
    scroller.current?.scrollTo({ x: clamped * width, animated: true });
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
          {spec.title ?? "Tickets"}
        </Text>
        <Chevron symbol="chevron.left" disabled={page === 0} onPress={() => go(page - 1)} />
        <Text variant="caption" color="textMuted" style={tabularNumbers}>
          {page + 1} / {count}
        </Text>
        <Chevron symbol="chevron.right" disabled={page === count - 1} onPress={() => go(page + 1)} />
      </View>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (
          <ScrollView
            ref={scroller}
            horizontal
            pagingEnabled
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
          >
            {spec.tickets.map((ticket, i) => (
              <View key={`${ticket.id}-${i}`} style={{ width }}>
                <TicketCard ticket={ticket} />
              </View>
            ))}
          </ScrollView>
        )}
      </View>
      {count > 1 && count <= 20 && (
        <View style={{ flexDirection: "row", justifyContent: "center", gap: spacing.xs }}>
          {spec.tickets.map((ticket, i) => (
            <View
              key={`${ticket.id}-${i}`}
              style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === page ? colors.accent : colors.hairline }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function Chevron({ symbol, disabled, onPress }: { symbol: "chevron.left" | "chevron.right"; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable hitSlop={10} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ opacity: disabled ? 0.3 : pressed ? 0.6 : 1 })}>
      <SymbolView name={symbol} size={14} tintColor={colors.textMuted} />
    </Pressable>
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
        <Pressable hitSlop={8} onPress={() => void Linking.openURL(url)} style={{ alignSelf: "flex-start" }}>
          <Text variant="caption" color="accent">
            Open in Linear ↗
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function Stat({ spec }: { spec: StatSpec }) {
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
      return { x, y, h, color: seriesColor(si, s.color) };
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
    return { path, color: seriesColor(si, s.color) };
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
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
      {spec.series.map((s, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: seriesColor(i, s.color) }} />
          <Text variant="caption" color="textMuted">
            {s.name ?? `Series ${i + 1}`}
          </Text>
        </View>
      ))}
    </View>
  );
}
