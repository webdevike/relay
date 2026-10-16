import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { spacing } from "@/theme";
import { Text } from "./Text";

export interface ExpandableContentProps {
  children: ReactNode;
  /** Height the content is clipped to before "Show more"; content shorter than this shows whole. */
  maxHeight: number;
}

/**
 * Content (markdown, text) clipped to `maxHeight`, with a left-aligned "Show more" / "Show less"
 * button under it when it overflows. The content lays out at full height inside the clip so its
 * natural height is known, which also covers rich children that `numberOfLines` cannot clamp.
 */
export function ExpandableContent({ children, maxHeight }: ExpandableContentProps) {
  const [fullHeight, setFullHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const overflows = fullHeight !== null && fullHeight > maxHeight + 1;
  return (
    <View>
      <View style={{ maxHeight: overflows && !expanded ? maxHeight : undefined, overflow: "hidden" }}>
        <View
          onLayout={(event) => {
            setFullHeight(event.nativeEvent.layout.height);
          }}
        >
          {children}
        </View>
      </View>
      {overflows && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setExpanded((current) => !current);
          }}
          hitSlop={spacing.sm}
          style={{ alignSelf: "flex-start", marginTop: spacing.md }}
        >
          <Text style={{ fontSize: 15, lineHeight: 20 }}>{expanded ? "Show less" : "Show more"}</Text>
        </Pressable>
      )}
    </View>
  );
}
