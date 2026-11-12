/**
 * A room an assistant set up from its chat (`[[room:<id>]]` in its reply, `splitRoomCards`): one
 * compact card that opens the room screen, with its title and members. On a host without chat rooms
 * (ROOMS_CHAT_FEATURE), or while the room is not on the wire (a proposal not convened yet, or
 * deleted), the reply shows `Room: <title>` instead.
 */
import { Keyboard, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { roomCardFallback, type RoomCardRef } from "@relay/protocol";
import { useRoom, useRoomsStore } from "@/state/rooms";
import { spacing, useColors } from "@/theme";
import { StatusCardRow } from "@/ui/StatusCardRow";
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
  const proposal = room.chat?.proposal === true;
  const line = `${proposal ? "Council" : "Room ready"} · ${room.title}`;
  return (
    <StatusCardRow
      // Desktop's ids for the same cards, so a dismissal on either shows on both.
      id={`room:${room.id}:${proposal ? "council" : "ready"}`}
      running={room.phase === "open" || room.phase === "wrapping"}
      line={line}
      accessibilityLabel={`Open the room ${room.title}${members === "" ? "" : `, ${members}`}`}
      lead={<SymbolView name="person.3" size={14} tintColor={colors.textMuted} />}
      onOpen={() => {
        Keyboard.dismiss();
        router.push(`/rooms/${encodeURIComponent(room.id)}`);
      }}
      style={styles.card}
      testID="room-card"
    />
  );
}

const styles = StyleSheet.create({
  fallback: { marginTop: spacing.xs },
  card: { marginTop: spacing.sm },
});
