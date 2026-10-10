import { useLocalSearchParams } from "expo-router";
import { AgentScreen } from "@/agents/AgentScreen";

/** One subagent, pushed from its parent's chips: the normal session screen pinned to it. */
export default function SubagentSession() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return <AgentScreen pinnedId={sessionId} />;
}
