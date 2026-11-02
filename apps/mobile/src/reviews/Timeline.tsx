/** An item's timeline: its own cards and activity lines with Astra's private threads merged in by time (`mergeTimeline`). */
import { Fragment, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import type { AstraItem } from "@relay/protocol";
import { spacing } from "@/theme";
import { AstraThreadCard } from "./AstraCards";
import type { TimelineRow } from "./model";

export interface TimelineProps<T> {
  rows: readonly TimelineRow<T>[];
  renderEntry: (entry: T, at: number) => ReactNode;
  /** The session the Astra threads came from (working, waiting, error, session id). */
  astra: AstraItem | undefined;
  now: number;
  onUseAsReply: (text: string) => void;
  onStop: () => void;
  /** A reply typed in a thread's own box (`ReviewComposer.replyInThread`). */
  onThreadReply: (rootText: string, text: string) => void;
  /** Isaac's name where the item knows it (Linear's viewer, his own Slack messages); else "You". */
  me?: string | undefined;
}

export function Timeline<T>({ rows, renderEntry, astra, now, onUseAsReply, onStop, onThreadReply, me }: TimelineProps<T>) {
  const router = useRouter();
  return (
    <View style={styles.list}>
      {rows.map((row) =>
        row.kind === "entry" ? (
          <Fragment key={row.key}>{renderEntry(row.entry, row.at)}</Fragment>
        ) : (
          <AstraThreadCard
            key={row.key}
            thread={row.thread}
            item={astra}
            now={now}
            name={me ?? "You"}
            onUseAsReply={onUseAsReply}
            onStop={onStop}
            onReply={onThreadReply}
            onOpenSession={(sessionId) => {
              router.push({ pathname: "/agents/[sessionId]", params: { sessionId } });
            }}
          />
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
});
