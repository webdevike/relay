/** An item's timeline: its own cards and activity lines with Astra's cards merged in by time (`mergeTimeline`). */
import { Fragment, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import type { AstraItem } from "@relay/protocol";
import { spacing } from "@/theme";
import { AskCard, AstraCard } from "./AstraCards";
import type { TimelineRow } from "./model";

export interface TimelineProps<T> {
  rows: readonly TimelineRow<T>[];
  renderEntry: (entry: T, at: number) => ReactNode;
  /** The session the Astra rows came from (working, waiting, error, session id). */
  astra: AstraItem | undefined;
  now: number;
  onUseAsReply: (text: string) => void;
  onStop: () => void;
}

export function Timeline<T>({ rows, renderEntry, astra, now, onUseAsReply, onStop }: TimelineProps<T>) {
  const router = useRouter();
  return (
    <View style={styles.list}>
      {rows.map((row) => {
        if (row.kind === "entry") return <Fragment key={row.key}>{renderEntry(row.entry, row.at)}</Fragment>;
        if (row.kind === "ask") return <AskCard key={row.key} text={row.text} at={row.at} now={now} />;
        return (
          <AstraCard
            key={row.key}
            turns={row.turns}
            last={row.last}
            item={astra}
            onUseAsReply={onUseAsReply}
            onStop={onStop}
            onOpenSession={(sessionId) => {
              router.push({ pathname: "/agents/[sessionId]", params: { sessionId } });
            }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
});
