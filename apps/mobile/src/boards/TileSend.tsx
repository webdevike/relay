/**
 * How a widget sends to an assistant (`assistantSend.ts`) where it is drawn. `useSendToAssistant()`
 * is what a widget button or Mantine page calls; outside a board tile it just sends. A board tile
 * wraps its widget in `TileSend`, which sends the same way and then shows a quiet caption under the
 * tile ("Sent to Penny", "Not sent: <the host's reason>") that fades out after a few seconds.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { agentTitle, useAssistantStore } from "@/state/assistant";
import { motion } from "@/theme";
import { Text } from "@/ui/Text";
import { sendCaption, sendToAssistant } from "./assistantSend";

/** Sends `text` as Isaac's turn to assistant `agent`. */
export type SendToAssistant = (agent: string, text: string) => void;

/** How long a tile's caption stays before it fades. */
const CAPTION_MS = 4000;

const Context = createContext<SendToAssistant>((agent, text) => {
  void sendToAssistant(agent, text);
});

export function useSendToAssistant(): SendToAssistant {
  return useContext(Context);
}

/** A board tile: its widget's sends to an assistant end in a caption under it. */
export function TileSend({ children }: { children: ReactNode }) {
  const [caption, setCaption] = useState<{ text: string; seq: number } | null>(null);
  // Only the newest tap's outcome shows.
  const latest = useRef(0);
  const send = useCallback<SendToAssistant>((agent, text) => {
    const outcome = sendToAssistant(agent, text);
    if (outcome === null) return;
    const seq = ++latest.current;
    void outcome.then((result) => {
      if (seq === latest.current)
        setCaption({
          text: sendCaption(result, agentTitle(useAssistantStore.getState().agents, agent)),
          seq,
        });
    });
  }, []);
  useEffect(() => {
    if (caption === null) return;
    const timer = setTimeout(() => {
      setCaption(null);
    }, CAPTION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [caption]);
  return (
    <Context.Provider value={send}>
      {children}
      {caption !== null ? (
        <Animated.View
          key={caption.seq}
          entering={FadeIn.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
        >
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {caption.text}
          </Text>
        </Animated.View>
      ) : null}
    </Context.Provider>
  );
}
