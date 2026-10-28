/**
 * A chat's canvas row wired to the app: whether its room is live comes from the host's room list,
 * Join asks for access and pushes the canvas screen over the chat (which stays mounted beneath,
 * scroll and draft intact), and the wrap-up summary renders as markdown.
 */
import { Keyboard } from "react-native";
import { useRouter } from "expo-router";
import type { CanvasEntry } from "@relay/protocol";
import { CanvasCard } from "@/ui/CanvasCard";
import { MessageText } from "@/agents/MessageText";
import { canvasJoinState, useCanvasStore } from "@/state/canvas";
import { useConnectionStore } from "@/state/connection";
import { hostBaseUrl, requestCanvasAccess } from "@/connection";

export interface CanvasEntryRowProps {
  entry: CanvasEntry;
  /** The chat this row is in, as an href: Back to chat replaces to it when there is nothing to go back to. */
  origin: string;
}

export function CanvasEntryRow({ entry, origin }: CanvasEntryRowProps) {
  const router = useRouter();
  const state = useCanvasStore((store) => canvasJoinState(store, entry.roomId));
  const connected = useConnectionStore((store) => store.status === "connected");
  const base = connected ? hostBaseUrl() : null;
  const avatarUri = base === null || entry.agent.avatar === undefined ? null : `${base}${entry.agent.avatar}`;
  const summary = entry.kind === "end" && entry.text !== undefined && entry.text.trim() !== "" ? <MessageText text={entry.text} /> : undefined;
  const join = (): void => {
    Keyboard.dismiss();
    requestCanvasAccess(entry.slug);
    router.push({
      pathname: "/canvas",
      params: {
        slug: entry.slug,
        roomId: entry.roomId,
        board: entry.board,
        agent: entry.agent.name,
        color: entry.agent.color,
        ...(entry.agent.avatar === undefined ? {} : { avatar: entry.agent.avatar }),
        origin,
      },
    });
  };
  return <CanvasCard entry={entry} state={state} avatarUri={avatarUri} canJoin={connected} onJoin={join} summary={summary} />;
}
