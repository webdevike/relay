/**
 * Live dashboards from the host. Without a slug: the list of boards. With one: that board's tiles
 * on the host's grid on larger screens and full-width tiles on phones, updated on `board.delta`.
 * A board fed by a host-side sampler (the office Wi-Fi meter) reads as a live view.
 */
import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import type { Board } from "@relay/protocol";
import { Screen } from "@/ui/Screen";
import { Row } from "@/ui/Row";
import { Separator } from "@/ui/Separator";
import { EmptyState } from "@/ui/EmptyState";
import { spacing } from "@/theme";
import { useBoardsStore } from "@/state/boards";
import { Widget } from "@/agents/Widget";

export default function Boards() {
  const { slug } = useLocalSearchParams<{ slug?: string }>();
  const boards = useBoardsStore((state) => state.boards);
  const board = slug === undefined ? undefined : boards.find((b) => b.slug === slug);

  if (slug !== undefined) {
    return (
      <Screen title={board?.title ?? "Board"}>
        {board === undefined ? (
          <EmptyState symbol="questionmark.square.dashed" title="Board not found" body="The host doesn't have this board right now." />
        ) : (
          <BoardGrid board={board} />
        )}
      </Screen>
    );
  }

  return (
    <Screen title="Boards">
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
  return (
    <View style={styles.grid}>
      {board.widgets.map((w) => (
        <View key={w.id} style={[styles.cell, { width: width < 600 ? "100%" : `${(w.span / 12) * 100}%` }]}>
          <Widget spec={w.spec} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: spacing.xl - spacing.xs },
  cell: { padding: spacing.xs },
});
