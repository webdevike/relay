/**
 * Live dashboards from the host. Without a slug: the list of boards. With one: that board's tiles
 * on the host's grid on larger screens and full-width tiles on phones, updated on `board.delta`.
 * A board fed by a host-side sampler (the office Wi-Fi meter) reads as a live view. A live tile
 * (an `openui` source) runs its Query statements over `query.req` while the board is open, on a
 * host whose welcome offers "query"; on an older host it draws the spec the host rendered.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { createOpenUIRuntime, type Board, type BoardWidget } from "@relay/protocol";
import { Screen } from "@/ui/Screen";
import { Row } from "@/ui/Row";
import { Separator } from "@/ui/Separator";
import { EmptyState } from "@/ui/EmptyState";
import { Text } from "@/ui/Text";
import { spacing } from "@/theme";
import { useBoardsStore } from "@/state/boards";
import { liveQuery } from "@/connection";
import { Widget } from "@/agents/Widget";
import { OpenUIRuntimeContext } from "@/agents/OpenUIRuntime";

export default function Boards() {
  const { slug } = useLocalSearchParams<{ slug?: string }>();
  const boards = useBoardsStore((state) => state.boards);
  const board = slug === undefined ? undefined : boards.find((b) => b.slug === slug);

  if (slug !== undefined) {
    return (
      <Screen title={board?.title ?? "Board"} scroll>
        {board === undefined ? (
          <EmptyState symbol="questionmark.square.dashed" title="Board not found" body="The host doesn't have this board right now." />
        ) : (
          <BoardGrid board={board} />
        )}
      </Screen>
    );
  }

  return (
    <Screen title="Boards" scroll>
      {boards.length === 0 ? (
        <EmptyState symbol="chart.xyaxis.line" title="No boards yet" body="Dashboards on the host show up here and update live." />
      ) : (
        boards.map((b, i) => (
          <View key={b.slug}>
            {i > 0 && <Separator />}
            <Row
              title={b.title}
              subtitle={`${b.widgets.length} tiles${b.workspace ? ` · ${b.workspace}` : ""}`}
              onPress={() => {
                router.push({ pathname: "/boards", params: { slug: b.slug } });
              }}
            />
          </View>
        ))
      )}
    </Screen>
  );
}

function BoardGrid({ board }: { board: Board }) {
  const { width } = useWindowDimensions();
  const queries = useBoardsStore((state) => state.queries);
  return (
    <View style={styles.grid}>
      {board.widgets.map((w) => (
        <View key={w.id} style={[styles.cell, { width: width < 600 ? "100%" : `${(w.span / 12) * 100}%` }]}>
          {queries && w.openui !== undefined ? <LiveTile widget={w} source={w.openui} /> : <Widget spec={w.spec} />}
        </View>
      ))}
    </View>
  );
}

/** A live tile: its own runtime while on screen, fetching and refreshing its Query data; the host's
 * static render shows until the source parses (it always should: the host checked it on write). */
function LiveTile({ widget, source }: { widget: BoardWidget; source: string }) {
  const [runtime] = useState(() => createOpenUIRuntime(source, { query: liveQuery }));
  useEffect(() => {
    runtime.update(source);
  }, [runtime, source]);
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const issue = snapshot.errors.find((e) => e.code === "query-error");
  return (
    <OpenUIRuntimeContext.Provider value={runtime}>
      <Widget spec={snapshot.node ?? widget.spec} />
      {issue ? (
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {issue.message}
        </Text>
      ) : null}
    </OpenUIRuntimeContext.Provider>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: spacing.md - spacing.xs },
  cell: { padding: spacing.xs },
});
