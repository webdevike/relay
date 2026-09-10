import { useEffect, useState } from "react";
import { FlatList } from "react-native";
import { useRouter } from "expo-router";
import type { AgentSession } from "@relay/protocol";
import { Screen } from "@/ui/Screen";
import { Row } from "@/ui/Row";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { StatusDot } from "@/ui/StatusDot";
import { EmptyState } from "@/ui/EmptyState";
import { useAgentsStore } from "@/state/agents";
import { relativeTime, truncate } from "@/lib/format";

const SUBTITLE_MAX = 80;
/** Relative times only change by the minute; re-render on that cadence, not per frame. */
const CLOCK_TICK_MS = 30_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

function SessionRow({ session, now, onPress }: { session: AgentSession; now: number; onPress: () => void }) {
  return (
    <Row
      title={session.title}
      subtitle={truncate(session.lastActivity, SUBTITLE_MAX)}
      leading={<StatusDot status={session.status} size={10} />}
      trailing={
        <Text variant="caption" color="textFaint" tabular>
          {relativeTime(session.lastActivityAt, now)}
        </Text>
      }
      onPress={onPress}
    />
  );
}

/** Every coding-agent session the host reports, most recent activity first. */
export default function AgentInbox() {
  const router = useRouter();
  const order = useAgentsStore((state) => state.order);
  const sessions = useAgentsStore((state) => state.sessions);
  const now = useNow();

  return (
    <Screen title="Agent Inbox">
      {order.length === 0 ? (
        <EmptyState
          symbol="tray"
          title="No agent sessions"
          body="Sessions show up here while omp is running on your host."
        />
      ) : (
        <FlatList
          data={order}
          keyExtractor={(id) => id}
          ItemSeparatorComponent={Separator}
          ListHeaderComponent={Separator}
          ListFooterComponent={Separator}
          renderItem={({ item: id }) => {
            const session = sessions[id];
            if (session === undefined) return null;
            return (
              <SessionRow
                session={session}
                now={now}
                onPress={() => {
                  router.push({ pathname: "/agents/[sessionId]", params: { sessionId: id } });
                }}
              />
            );
          }}
        />
      )}
    </Screen>
  );
}
