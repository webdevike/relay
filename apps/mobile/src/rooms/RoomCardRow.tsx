/**
 * A room an assistant set up from its chat (`[[room:<id>]]` in its reply, `splitRoomCards`): one
 * compact card that opens the room screen, with its title and members. On a host without chat rooms
 * (ROOMS_CHAT_FEATURE), or while the room is not on the wire (a proposal not convened yet, or
 * deleted), the reply shows `Room: <title>` instead.
 */
import { Keyboard, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { roomCardFallback, type RoomCardRef } from "@relay/protocol";
import { tapHaptic } from "@/lib/haptics";
import { useRoom, useRoomsStore } from "@/state/rooms";
import { radii, spacing, useColors } from "@/theme";
import { Text } from "@/ui/Text";

export function RoomCardRow({ refRoom }: { refRoom: RoomCardRef }) {
  const router = useRouter();
  const colors = useColors();
  const chats = useRoomsStore((state) => state.chats);
  const room = useRoom(refRoom.id);
  if (!chats || room === undefined)
    return (
      <Text variant="label" color="textMuted" style={styles.fallback} testID="room-card-fallback">
        {roomCardFallback(refRoom)}
      </Text>
    );
  const members = room.chat?.setup.members.map((m) => (m.role ? `${m.name.split(/\s+/)[0]} · ${m.role}` : m.name)).join(", ") ?? "";
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open the room ${room.title}`}
      onPress={() => {
        tapHaptic();
        Keyboard.dismiss();
        router.push(`/rooms/${encodeURIComponent(room.id)}`);
      }}
      style={({ pressed }) => [styles.card, { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline, opacity: pressed ? 0.7 : 1 }]}
      testID="room-card"
    >
      <Text variant="caption" color="textMuted">
        {room.chat?.proposal === true ? "Council" : "Room ready"}
      </Text>
      <Text variant="body" numberOfLines={2}>
        {room.title}
      </Text>
      {members !== "" && (
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {members}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fallback: { marginTop: spacing.xs },
  card: { marginTop: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, gap: spacing.xs },
});
