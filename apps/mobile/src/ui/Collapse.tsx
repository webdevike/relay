import { useState, type ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { SymbolView } from "expo-symbols";
import { tapHaptic } from "@/lib/haptics";
import { spacing, useColors } from "@/theme";
import { Text } from "./Text";

export interface CollapseProps {
  title: string;
  /** A muted count after the title ("Resolved 3"). */
  count?: number;
  initiallyOpen?: boolean;
  /** Space between the header and the content and between content children; `spacing.sm` by default. */
  gap?: number;
  /** Extra style on the header row, e.g. the horizontal inset of a full-width list. */
  headerStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/** A header row with a chevron that shows or hides the content under it. */
export function Collapse({ title, count, initiallyOpen = false, gap = spacing.sm, headerStyle, children }: CollapseProps) {
  const colors = useColors();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={{ gap }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={count === undefined ? title : `${title}, ${String(count)}`}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tapHaptic();
          setOpen((current) => !current);
        }}
        style={({ pressed }) => [
          {
            minHeight: 32,
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            opacity: pressed ? 0.7 : 1,
          },
          headerStyle,
        ]}
      >
        <Text variant="label" style={{ flex: 1 }}>
          {title}
          {count !== undefined && <Text variant="label" color="textMuted">{`  ${String(count)}`}</Text>}
        </Text>
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColor={colors.textMuted}
        />
      </Pressable>
      {open && <View style={{ gap }}>{children}</View>}
    </View>
  );
}
