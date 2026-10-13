import { View } from "react-native";
import { spacing, type, useColors, type ColorToken } from "@/theme";
import { Text } from "./Text";

const DOT = 8;

export interface TimelineItemProps {
  title: string;
  time?: string | undefined;
  text?: string | undefined;
  /** Dot color; the rail itself stays a hairline. */
  color?: ColorToken;
  /** The last item ends the rail at its dot. */
  last?: boolean;
}

/** One event on a vertical rail: a dot, the title with its time right-aligned, detail below. */
export function TimelineItem({ title, time, text, color = "textFaint", last = false }: TimelineItemProps) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", gap: spacing.md }}>
      <View style={{ width: DOT, alignItems: "center" }}>
        <View
          style={{
            width: DOT,
            height: DOT,
            borderRadius: DOT / 2,
            marginTop: (type.label.lineHeight - DOT) / 2,
            backgroundColor: colors[color],
          }}
        />
        {!last && (
          <View
            style={{ flex: 1, width: 1, marginTop: spacing.xs, backgroundColor: colors.hairline }}
          />
        )}
      </View>
      <View style={{ flex: 1, gap: 2, paddingBottom: last ? 0 : spacing.md }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
          <Text variant="label" style={{ flex: 1 }}>
            {title}
          </Text>
          {time !== undefined && time !== "" && (
            <Text variant="caption" color="textMuted" tabular>
              {time}
            </Text>
          )}
        </View>
        {text !== undefined && text !== "" && (
          <Text variant="caption" color="textMuted">
            {text}
          </Text>
        )}
      </View>
    </View>
  );
}
