/** One row of the Rooms list: title, notch, status, spend and a live dot. */
import { Pressable, View } from "react-native";
import { councilMoney, type RoomWire } from "@relay/protocol";
import { spacing, useColors } from "@/theme";
import { Text } from "@/ui/Text";
import { notchName, roomLive, roomStatus } from "./model";
import { Tag } from "./primitives";

export function RoomRow({ room, onPress }: { room: RoomWire; onPress: () => void }) {
  const colors = useColors();
  const live = roomLive(room);
  const notch = notchName(room);
  const spent = room.council?.spend.usd;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${room.title}. ${notch ?? "Debate"}. ${roomStatus(room)}${live ? ". Running" : ""}`}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 76, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs + 2, justifyContent: "center", opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        {live && <View accessibilityLabel="Running" style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.ok }} />}
        <Text variant="title" numberOfLines={2} style={{ flex: 1 }}>
          {room.title === "" ? "Untitled room" : room.title}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Tag label={notch ?? "Debate"} tone={notch === null ? "textMuted" : "accent"} />
        <Text variant="label" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>
          {roomStatus(room)}
        </Text>
        {spent !== undefined && (
          <Text variant="label" color="textMuted" tabular>
            {councilMoney(spent)}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
