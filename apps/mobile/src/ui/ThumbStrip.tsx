import { useEffect, useRef } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
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
  /** Still being made: its own slot, selectable, with a spinner over the picture it grows from. */
  busy?: boolean;
  accessibilityLabel: string;
}

export interface ThumbStripProps {
  items: readonly ThumbStripItem[];
  selected: string | undefined;
  onSelect: (key: string) => void;
}

/** A sideways row of small square thumbnails on dark chrome, the chosen one outlined white and kept in view. */
export function ThumbStrip({ items, selected, onSelect }: ThumbStripProps) {
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
            {item.uri !== null && <Image source={{ uri: item.uri }} blurRadius={item.busy === true ? 8 : 0} resizeMode="cover" style={{ flex: 1, opacity: on ? 1 : 0.75 }} />}
            {item.busy === true && (
              <View pointerEvents="none" style={{ ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.35)" }}>
                <ActivityIndicator color="#FFFFFF" />
              </View>
            )}
            {item.video === true && (
              <View pointerEvents="none" style={{ position: "absolute", left: 4, bottom: 4 }}>
                <SymbolView name="play.fill" size={11} tintColor="#FFFFFF" />
              </View>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
