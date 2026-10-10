import { useLocalSearchParams } from "expo-router";
import { AgentScreen } from "@/agents/AgentScreen";

/** The Agent Inbox. A tapped notification arrives as `?sessionId=` and focuses that session. */
export default function AgentInbox() {
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
  return <AgentScreen {...(sessionId === undefined ? {} : { linkedId: sessionId })} />;
}
