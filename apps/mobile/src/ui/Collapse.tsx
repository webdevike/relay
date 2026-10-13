import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { tapHaptic } from "@/lib/haptics";
import { spacing, useColors } from "@/theme";
import { Text } from "./Text";

export interface CollapseProps {
  title: string;
  initiallyOpen?: boolean;
  children: ReactNode;
}

/** A header row with a chevron that shows or hides the content under it. */
export function Collapse({ title, initiallyOpen = false, children }: CollapseProps) {
  const colors = useColors();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={{ gap: spacing.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tapHaptic();
          setOpen((current) => !current);
        }}
        style={({ pressed }) => ({
          minHeight: 32,
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text variant="label" style={{ flex: 1 }}>
          {title}
        </Text>
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColor={colors.textMuted}
        />
      </Pressable>
      {open && <View style={{ gap: spacing.sm }}>{children}</View>}
    </View>
  );
}
