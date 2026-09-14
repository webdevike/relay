/**
 * One drop in the Drops list. Not `ui/Row`: that one has no long press, and the drop sheet lives
 * on a hold. Same geometry and press feedback, so the list reads like the rest of the app.
 */
import { Pressable, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { Drop, DropKind } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { colors, spacing } from "@/theme";
import { byteSize, relativeTime } from "@/lib/format";
import { tapHaptic } from "@/lib/haptics";

export interface DropRowProps {
  drop: Drop;
  /** What the host is called in "from ...": the Mac's name once known. */
  hostName: string | null;
  onPress: (drop: Drop) => void;
  onLongPress: (drop: Drop) => void;
}

const symbolFor: Record<DropKind, SFSymbol> = {
  text: "doc.text",
  link: "link",
  image: "photo",
  file: "doc",
};

function dropSubtitle(drop: Drop, hostName: string | null, now: number = Date.now()): string {
  const origin = drop.origin === "host" ? (hostName ?? "your Mac") : "iPhone";
  const parts = [relativeTime(drop.createdAt, now), `from ${origin}`];
  if (drop.file !== undefined) parts.push(byteSize(drop.file.size));
  return parts.join(", ");
}

export function DropRow({ drop, hostName, onPress, onLongPress }: DropRowProps) {
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress(drop);
      }}
      onLongPress={() => {
        onLongPress(drop);
      }}
      style={({ pressed }) => ({ backgroundColor: pressed ? colors.surfaceRaised : "transparent" })}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 44,
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.md,
          gap: spacing.md,
        }}
      >
        <SymbolView name={symbolFor[drop.kind]} size={22} tintColor={colors.accent} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="title" numberOfLines={1}>
            {drop.title}
          </Text>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {dropSubtitle(drop, hostName)}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
