/**
 * Dev-only (`__DEV__`): fills the Rooms store with fixture rooms and opens a Rooms screen, so the
 * screens can be looked at in the Simulator with no host: `relay://rooms/dev?to=/rooms/maul-1&img=<base>`.
 * `img` is a folder URL holding `target.jpg`, `before.jpg`, `head.jpg`, `body.jpg`, `round1-full.jpg`
 * for the fixtures' renders. A release build shows nothing here.
 */
import { useEffect } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { FIXTURE_RENDERS, FIXTURE_ROOMS } from "@/rooms/fixtures";
import { roomImages } from "@/rooms/useRoomImage";
import { useConnectionStore } from "@/state/connection";
import { useRoomsStore } from "@/state/rooms";

const FILES: Record<string, string> = {
  [FIXTURE_RENDERS.target]: "target.jpg",
  [FIXTURE_RENDERS.before]: "before.jpg",
  [FIXTURE_RENDERS.r1]: "round1-full.jpg",
  [FIXTURE_RENDERS.head]: "head.jpg",
  [FIXTURE_RENDERS.body]: "body.jpg",
};

export default function RoomsDev() {
  const { to, img } = useLocalSearchParams<{ to?: string; img?: string }>();
  const router = useRouter();
  useEffect(() => {
    if (!__DEV__) return;
    useConnectionStore.setState({ status: "connected" });
    useRoomsStore.setState({ supported: true, loaded: true, rooms: FIXTURE_ROOMS });
    if (img !== undefined) {
      for (const room of FIXTURE_ROOMS)
        for (const [path, file] of Object.entries(FILES))
          for (const max of [512, 2048]) roomImages.put(room.id, path, max, `${img}/${file}`);
    }
    router.replace((to ?? "/rooms") as Href);
  }, [to, img, router]);
  return null;
}
