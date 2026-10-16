import { useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { spacing } from "@/theme";
import { EdgeFade } from "./EdgeFade";
import { Text } from "./Text";

export interface ExpandableContentProps {
  children: ReactNode;
  /** Height the content is clipped to before "Show more"; content shorter than this shows whole. */
  maxHeight: number;
  /** Height of the fade that softens the clip's bottom edge; none when omitted. */
  fadeHeight?: number;
  /** The surface the content sits on as `#RRGGBB`: the fade runs from it to transparent. Required with `fadeHeight`. */
  fadeColor?: string;
  /** Called once the layout has settled after "Show more" with how much taller the content became, so a scroller can keep the clip in place. */
  onExpanded?: (growth: number) => void;
}

/**
 * Content (markdown, text) clipped to `maxHeight`, with a left-aligned "Show more" / "Show less"
 * button under it when it overflows. The content lays out at full height inside the clip so its
 * natural height is known, which also covers rich children that `numberOfLines` cannot clamp.
 */
export function ExpandableContent({ children, maxHeight, fadeHeight = 0, fadeColor, onExpanded }: ExpandableContentProps) {
  const [fullHeight, setFullHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Height of the whole block as last laid out, and whether a "Show more" tap awaits its re-layout.
  const blockHeight = useRef(0);
  const expanding = useRef(false);
  const overflows = fullHeight !== null && fullHeight > maxHeight + 1;
  const fading = overflows && !expanded && fadeHeight > 0 && fadeColor !== undefined;
  return (
    <View
      onLayout={(event) => {
        const height = event.nativeEvent.layout.height;
        if (expanding.current) {
          expanding.current = false;
          onExpanded?.(height - blockHeight.current);
        }
        blockHeight.current = height;
      }}
    >
      <View style={{ maxHeight: overflows && !expanded ? maxHeight : undefined, overflow: "hidden" }}>
        <View
          onLayout={(event) => {
            setFullHeight(event.nativeEvent.layout.height);
          }}
        >
          {children}
        </View>
        {fading && <EdgeFade color={fadeColor} height={fadeHeight} strength={1} solid={0} edge="bottom" />}
      </View>
      {overflows && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            expanding.current = !expanded;
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
