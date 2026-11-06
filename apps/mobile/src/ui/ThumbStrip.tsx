import { useEffect, useRef } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { radii, spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

const THUMB = 52;
const BORDER = 2;
const FILL = "#1A1B1E";

export interface ThumbStripItem {
  key: string;
  /** Null while there is nothing to fetch it from. */
  uri: string | null;
  /** A play glyph on it. */
  video?: boolean;
  accessibilityLabel: string;
}

export interface ThumbStripProps {
  items: readonly ThumbStripItem[];
  selected: string | undefined;
  onSelect: (key: string) => void;
  /** A spinner tile after the last one: something new is on its way. */
  pending?: boolean;
}

/** A sideways row of small square thumbnails on dark chrome, the chosen one outlined white and kept in view. */
export function ThumbStrip({ items, selected, onSelect, pending = false }: ThumbStripProps) {
  const scroller = useRef<ScrollView>(null);
  const index = items.findIndex((item) => item.key === selected);
  useEffect(() => {
    if (index >= 0) scroller.current?.scrollTo({ x: Math.max(0, index * (THUMB + spacing.sm) - THUMB * 2), animated: true });
  }, [index]);
  return (
    <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}>
      {items.map((item) => {
        const on = item.key === selected;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="imagebutton"
            accessibilityLabel={item.accessibilityLabel}
            accessibilityState={{ selected: on }}
            onPress={() => {
              tapHaptic();
              onSelect(item.key);
            }}
            style={{ width: THUMB, height: THUMB, borderRadius: radii.md, borderWidth: BORDER, borderColor: on ? "#FFFFFF" : "transparent", overflow: "hidden", backgroundColor: FILL }}
          >
            {item.uri !== null && <Image source={{ uri: item.uri }} resizeMode="cover" style={{ flex: 1, opacity: on ? 1 : 0.75 }} />}
            {item.video === true && (
              <View pointerEvents="none" style={{ position: "absolute", left: 4, bottom: 4 }}>
                <SymbolView name="play.fill" size={11} tintColor="#FFFFFF" />
              </View>
            )}
          </Pressable>
        );
      })}
      {pending && (
        <View accessibilityLabel="Generating" style={{ width: THUMB, height: THUMB, borderRadius: radii.md, backgroundColor: FILL, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      )}
    </ScrollView>
  );
}
