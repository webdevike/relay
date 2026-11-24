/**
 * What a running card shows of a run (Relay ask cards, Isaac 2026-11-24): `RunMeta`, the line under
 * its title (the ticking clock, the provider's logo and the model's name as plain muted text), and
 * `RunLog`, the box of its last few lines of work, newest last and in full text colour. No progress
 * bar or estimate: those were inaccurate (Relay #13). Values from the prototype (`.runHead`, `.runLog`).
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { radii, useColors } from "@/theme";

export function RunMeta({ clock, logo, model }: { clock: string | null; logo: ReactNode; model: string | null }) {
  if (clock === null && model === null) return null;
  return (
    <View style={styles.meta}>
      {clock !== null && (
        <Text variant="caption" color="textMuted" tabular accessibilityLabel={`Running for ${clock}`}>
          {clock}
        </Text>
      )}
      {model !== null && (
        <View style={styles.model}>
          {logo}
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {model}
          </Text>
        </View>
      )}
    </View>
  );
}

export function RunLog({ lines }: { lines: readonly string[] }) {
  const colors = useColors();
  if (lines.length === 0) return null;
  return (
    <View style={[styles.log, { borderColor: colors.hairline }]} accessible accessibilityLabel={`Recent work: ${lines.join(". ")}`}>
      {lines.map((line, index) => (
        <Text key={`${String(index)}:${line}`} variant="caption" color={index === lines.length - 1 ? "text" : "textMuted"} style={styles.line}>
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
  model: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 4 },
  log: { marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md },
  line: { lineHeight: 18 },
});
