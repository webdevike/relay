/** Boards widget (small only): how many live dashboards the host has and the first one's title. Opens /boards. */
import { StyleSheet } from "react-native";
import { Text } from "@/ui/Text";
import { countOf } from "@/lib/format";
import { useBoardsStore } from "@/state/boards";
import { WidgetFigure, WidgetHeader, WidgetNote, WidgetSpacer, WidgetSurface, type WidgetBodyProps } from "../WidgetParts";

export function BoardsWidget({ open, a11y }: WidgetBodyProps) {
  const boards = useBoardsStore((state) => state.boards);
  const first = boards[0];
  return (
    <WidgetSurface
      label={first === undefined ? "Boards. No boards yet" : `Boards. ${countOf(boards.length, "board")}, first ${first.title}`}
      href="/boards"
      open={open}
      a11y={a11y}
    >
      <WidgetHeader symbol="chart.xyaxis.line" title="Boards" color="green" />
      <WidgetSpacer />
      {first === undefined ? (
        <WidgetNote text="No boards yet" />
      ) : (
        <>
          <WidgetFigure value={String(boards.length)} />
          <Text variant="label" numberOfLines={2} style={styles.title}>
            {first.title}
          </Text>
          {boards.length > 1 && (
            <Text variant="caption" color="textFaint" numberOfLines={1}>
              and {boards.length - 1} more
            </Text>
          )}
        </>
      )}
    </WidgetSurface>
  );
}

const styles = StyleSheet.create({ title: { fontWeight: "600" } });
