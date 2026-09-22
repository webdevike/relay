/**
 * Renders a generative-UI widget spec (see widget.ts) natively — no WebView, no code
 * execution. Charts draw on Skia (already in the app) with a plain-View fallback when the
 * native module is absent. Deterministic and instant: the agent writes the spec, this paints it.
 */
import { useState } from "react";
import { View } from "react-native";
import { loadSkia } from "@/dictation/skia";
import { colors, radii, spacing, type } from "@/theme";
import { Text } from "@/ui/Text";
import type { ChartSpec, StatSpec, WidgetSpec } from "./widget";

const CHART_HEIGHT = 140;
const PALETTE = [colors.accent, colors.ok, colors.warn, colors.danger];
const seriesColor = (index: number, color?: string): string => color ?? PALETTE[index % PALETTE.length] ?? colors.accent;

export function Widget({ spec }: { spec: WidgetSpec }) {
  return (
    <View style={{ borderWidth: 1, borderColor: colors.hairline, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm }}>
      {spec.widget === "chart" ? <Chart spec={spec} /> : <Stat spec={spec} />}
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
  const max = Math.max(1, ...spec.series.flatMap((s) => s.points));
  const labelCount = Math.max(...spec.series.map((s) => s.points.length));

  return (
    <View style={{ gap: spacing.sm }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <View style={{ height: CHART_HEIGHT }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (spec.kind === "bar" ? <Bars spec={spec} width={width} max={max} /> : <Lines spec={spec} width={width} max={max} />)}
      </View>
      {spec.labels !== undefined && <AxisLabels labels={spec.labels} count={labelCount} width={width} />}
      {spec.series.length > 1 && <Legend spec={spec} />}
    </View>
  );
}

function Bars({ spec, width, max }: { spec: ChartSpec; width: number; max: number }) {
  const sk = loadSkia();
  const groups = Math.max(...spec.series.map((s) => s.points.length));
  const groupWidth = width / groups;
  const barWidth = (groupWidth * 0.7) / spec.series.length;
  const gap = groupWidth * 0.15;

  const rects = spec.series.flatMap((s, si) =>
    s.points.map((v, gi) => ({
      x: gi * groupWidth + gap + si * barWidth,
      y: CHART_HEIGHT - (v / max) * CHART_HEIGHT,
      h: (v / max) * CHART_HEIGHT,
      color: seriesColor(si, s.color),
    })),
  );

  if (sk === null) {
    return (
      <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-end" }}>
        {rects.map((r, i) => (
          <View key={i} style={{ position: "absolute", left: r.x, bottom: 0, width: barWidth, height: r.h, backgroundColor: r.color, borderRadius: 2 }} />
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
