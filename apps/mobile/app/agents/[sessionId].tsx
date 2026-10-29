import { useLocalSearchParams } from "expo-router";
import { AgentScreen } from "@/agents/AgentScreen";

/**
 * One session pushed on its own: a subagent from its parent's chips, or a session an assistant
 * started (auto-work) from that assistant's thread. The normal session screen pinned to it.
 */
export default function SubagentSession() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return <AgentScreen pinnedId={sessionId} />;
}
