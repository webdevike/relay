/** The hook behind every room image: a thumbnail, a reference or the full-screen view. */
import { useEffect, useState } from "react";
import { roomsRequest } from "@/connection";
import { requestOutcome } from "@/connection/rooms";
import { createImageCache } from "./images";

/** The host's answer to an image command: a data URL, bare or as `{ dataUrl }`. */
function dataUrlOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "dataUrl" in value && typeof value.dataUrl === "string") return value.dataUrl;
  return null;
}

export const roomImages = createImageCache(async (roomId, path, max) => {
  const result = await requestOutcome(roomsRequest({ op: "image", roomId, path, max }));
  return result.ok ? dataUrlOf(result.value) : null;
});

export interface RoomImageState {
  uri: string | null;
  /** The host could not make it (or is not there); a new mount asks again. */
  failed: boolean;
}

/** The data URL of `path` in room `roomId`, at most `max` px on its long side. */
export function useRoomImage(roomId: string, path: string | undefined, max = 512): RoomImageState {
  const [state, setState] = useState<RoomImageState>(() => ({ uri: path === undefined ? null : (roomImages.peek(roomId, path, max) ?? null), failed: false }));
  useEffect(() => {
    if (path === undefined) {
      setState({ uri: null, failed: true });
      return;
    }
    const cached = roomImages.peek(roomId, path, max);
    if (cached !== undefined) {
      setState({ uri: cached, failed: false });
      return;
    }
    let live = true;
    setState({ uri: null, failed: false });
    void roomImages.load(roomId, path, max).then((uri) => {
      if (live) setState({ uri, failed: uri === null });
    });
    return () => {
      live = false;
    };
  }, [roomId, path, max]);
  return state;
}
