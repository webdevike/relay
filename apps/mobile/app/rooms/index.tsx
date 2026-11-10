/**
 * Rooms (`/rooms`): every room Relay Desktop runs, newest first. Each row has the title, the effort
 * notch it runs at, where it is, what it has spent and a green dot while it works. Only on a host
 * that relays rooms (`welcome.features` has "rooms"); an older host gets one line saying to update.
 */
import { useCallback } from "react";
import { FlatList } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { requestRooms } from "@/connection";
import { Bar, TAP } from "@/rooms/primitives";
import { RoomRow } from "@/rooms/RoomRow";
import { useConnectionStore } from "@/state/connection";
import { useRoomsStore } from "@/state/rooms";
import { spacing } from "@/theme";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { Screen } from "@/ui/Screen";
import { Separator } from "@/ui/Separator";

export default function Rooms() {
  const router = useRouter();
  const supported = useRoomsStore((s) => s.supported);
  const loaded = useRoomsStore((s) => s.loaded);
  const rooms = useRoomsStore((s) => s.rooms);
  const connected = useConnectionStore((s) => s.status === "connected");
  useFocusEffect(
    useCallback(() => {
      requestRooms();
    }, []),
  );
  const back = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const add = (
    <Button label="New room" symbol="plus" height={TAP} pill disabled={supported !== true} onPress={() => { router.push("/rooms/new"); }} />
  );
  let body;
  if (!connected) {
    body = <EmptyState symbol="wifi.slash" title="Not connected" body="Rooms come from your Mac. Connect to see them." />;
  } else if (supported !== true) {
    body = <EmptyState symbol="arrow.down.circle" title="Update Relay Host on your Mac to use Rooms" body="This host is too old to relay rooms. Nothing is sent to it." />;
  } else if (!loaded) {
    body = <EmptyState symbol="rectangle.3.group" title="Loading rooms" body="Asking your Mac." />;
  } else if (rooms.length === 0) {
    body = <EmptyState symbol="rectangle.3.group" title="No rooms yet" body="Start one with a brief and an effort level. Low is one model; high is a team that builds in parallel." actionLabel="New room" onAction={() => { router.push("/rooms/new"); }} />;
  } else {
    body = (
      <FlatList
        data={rooms}
        keyExtractor={(room) => room.id}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={{ paddingBottom: spacing.xxxl }}
        renderItem={({ item }) => (
          <RoomRow room={item} onPress={() => { router.push({ pathname: "/rooms/[id]", params: { id: item.id } }); }} />
        )}
      />
    );
  }
  return (
    <Screen header={<Bar title="Rooms" onBack={back} right={add} />}>
      {body}
    </Screen>
  );
}
