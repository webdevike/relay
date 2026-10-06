import { Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { spacing, tabularNumbers, useColors } from "@/theme";
import { Text } from "@/ui/Text";

/** "3 / 12" page position. `overlay` tone is white label text for use over media. */
export function PageCounter({
  page,
  count,
  tone,
}: {
  page: number;
  count: number;
  tone?: "default" | "overlay" | undefined;
}) {
  const label = `${page + 1} / ${count}`;
  if (tone === "overlay") {
    return (
      <Text variant="label" style={[tabularNumbers, { color: "#FFFFFF" }]}>
        {label}
      </Text>
    );
  }
  return (
    <Text variant="caption" color="textMuted" style={tabularNumbers}>
      {label}
    </Text>
  );
}

/** Previous / counter / next row for stepping through pages; hidden when there is a single page. */
export function PageStepper({
  page,
  count,
  onChange,
}: {
  page: number;
  count: number;
  onChange: (next: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
      <StepChevron
        symbol="chevron.left"
        disabled={page <= 0}
        onPress={() => {
          onChange(page - 1);
        }}
      />
      <PageCounter page={page} count={count} />
      <StepChevron
        symbol="chevron.right"
        disabled={page >= count - 1}
        onPress={() => {
          onChange(page + 1);
        }}
      />
    </View>
  );
}

function StepChevron({
  symbol,
  disabled,
  onPress,
}: {
  symbol: "chevron.left" | "chevron.right";
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      hitSlop={10}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.3 : pressed ? 0.6 : 1 })}
    >
      <SymbolView name={symbol} size={14} tintColor={colors.textMuted} />
    </Pressable>
  );
}

/** Dot strip marking the current page; hidden for a single page or more than `max` (default 20) pages. */
export function PageDots({
  page,
  count,
  max,
}: {
  page: number;
  count: number;
  max?: number | undefined;
}) {
  const colors = useColors();
  if (count <= 1 || count > (max ?? 20)) return null;
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", gap: spacing.xs }}>
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i === page ? colors.accent : colors.hairline,
          }}
        />
      ))}
    </View>
  );
}
