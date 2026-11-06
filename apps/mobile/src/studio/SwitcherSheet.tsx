/**
 * The project switcher under the screen's title: All images, Favorites, every project with its
 * cover and count, Unsorted, and New project (which opens the new project).
 */
import type { ReactNode } from "react";
import { Image, Pressable, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { STUDIO_UNSORTED } from "@relay/protocol";
import { radii, spacing, toneFill, useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { sameView, type LibraryView, type SwitcherRow } from "./library";

const COVER = 36;

export interface SwitcherSheetProps {
  visible: boolean;
  rows: readonly SwitcherRow[];
  current: LibraryView;
  base: string | null;
  onPick: (view: LibraryView) => void;
  onNewProject: () => void;
  onClose: () => void;
}

export function SwitcherSheet({ visible, rows, current, base, onPick, onNewProject, onClose }: SwitcherSheetProps) {
  const colors = useColors();
  const row = (key: string, label: string, onPress: () => void, leading: ReactNode, count?: number, on = false) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.sm, borderRadius: radii.md, backgroundColor: on ? toneFill(colors, "accent", 0.12) : pressed ? colors.surfaceRaised : "transparent" })}
    >
      {leading}
      <Text variant="body" color={on ? "accent" : "text"} numberOfLines={1} style={{ flex: 1 }}>
        {label}
      </Text>
      {count !== undefined && (
        <Text variant="caption" color="textMuted" tabular>
          {count}
        </Text>
      )}
    </Pressable>
  );
  const glyph = (symbol: SFSymbol) => (
    <View style={{ width: COVER, height: COVER, borderRadius: radii.sm, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" }}>
      <SymbolView name={symbol} size={16} tintColor={colors.textMuted} />
    </View>
  );
  const cover = (r: SwitcherRow) => {
    if (r.view.kind === "all") return glyph("photo.on.rectangle");
    if (r.view.kind === "favorites") return glyph("heart");
    if (r.view.id === STUDIO_UNSORTED) return glyph("tray");
    return r.cover !== undefined && base !== null ? <Image source={{ uri: `${base}${r.cover}` }} resizeMode="cover" style={{ width: COVER, height: COVER, borderRadius: radii.sm }} /> : glyph("folder");
  };
  const item = (r: SwitcherRow) =>
    row(
      r.view.kind === "project" ? r.view.id : r.view.kind,
      r.name,
      () => {
        onPick(r.view);
      },
      cover(r),
      r.count,
      sameView(r.view, current),
    );
  // `switcherRows` order: All images, Favorites, the projects, Unsorted.
  const [all, favorites, ...rest] = rows;
  const unsorted = rest.at(-1);
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ gap: 2, paddingTop: spacing.sm }}>
        {all !== undefined && item(all)}
        {favorites !== undefined && item(favorites)}
        <Text variant="caption" color="textMuted" style={{ paddingHorizontal: spacing.sm, paddingTop: spacing.md, paddingBottom: spacing.xs }}>
          Projects
        </Text>
        {rest.slice(0, -1).map(item)}
        {unsorted !== undefined && item(unsorted)}
        {row("new", "New project", onNewProject, glyph("plus"))}
      </View>
    </Sheet>
  );
}
