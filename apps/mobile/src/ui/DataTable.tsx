import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { TableCellIcon } from "@relay/protocol";
import { openExternal } from "@/lib/links";
import { spacing, useColors, type ColorToken } from "@/theme";
import { BrandIcon } from "./BrandIcon";
import { Text } from "./Text";

const ICON_SIZE = 14;

/** Rough advance of one 13pt character, for sizing columns before anything is measured. */
const CHAR_WIDTH = 7;
const MIN_COLUMN = 56;
/** Wider text wraps inside its column instead of stretching the table further. */
const MAX_COLUMN = 220;

export type DataAlign = "left" | "right" | "center";

export interface DataColumn {
  label: string;
  align: DataAlign;
}

export interface DataCell {
  text: string;
  color?: ColorToken | undefined;
  bold?: boolean | undefined;
  /** Tapping the cell opens this http(s) URL externally; the text takes the accent color. */
  url?: string | undefined;
  /** Brand mark drawn before the text, in the text color. */
  icon?: TableCellIcon | undefined;
}

export interface DataTableProps {
  columns: DataColumn[];
  /** One cell per column in every row. */
  rows: DataCell[][];
}

/**
 * Rows on hairlines under a muted, semibold header. Columns are sized to their longest text, grown
 * to fill the container when they fit, and scroll sideways when they don't. Right-aligned columns
 * use tabular numbers so figures line up.
 */
export function DataTable({ columns, rows }: DataTableProps) {
  const [width, setWidth] = useState(0);
  const natural = columns.map((column, c) => {
    const chars = Math.max(
      column.label.length,
      ...rows.map((row) => (row[c]?.text.length ?? 0) + (row[c]?.icon === undefined ? 0 : 3)),
    );
    return Math.min(Math.max(chars * CHAR_WIDTH + spacing.sm * 2, MIN_COLUMN), MAX_COLUMN);
  });
  const total = natural.reduce((sum, w) => sum + w, 0);
  const grow = width > total ? width / total : 1;
  const widths = natural.map((w) => w * grow);
  const header = columns.map((column) => ({ text: column.label, color: "textMuted" as const, bold: true }));

  return (
    <View
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
      }}
    >
      {/* flexGrow 0: ScrollView's default grow inflates a shrink-to-fit parent (a user bubble). */}
      <ScrollView
        horizontal
        style={{ flexGrow: 0 }}
        bounces={false}
        scrollEnabled={total > width}
        showsHorizontalScrollIndicator={false}
      >
        <View>
          <DataRow cells={header} columns={columns} widths={widths} first />
          {rows.map((row, r) => (
            <DataRow key={r} cells={row} columns={columns} widths={widths} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

interface DataRowProps {
  cells: DataCell[];
  columns: DataColumn[];
  widths: number[];
  first?: boolean;
}

function DataRow({ cells, columns, widths, first = false }: DataRowProps) {
  const colors = useColors();
  const last = columns.length - 1;
  return (
    <View
      style={{
        flexDirection: "row",
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.hairline,
      }}
    >
      {columns.map((column, c) => {
        const cell = cells[c];
        const color = cell?.color ?? (cell?.url === undefined ? "text" : "accent");
        const text = cell?.text ?? "";
        const label = (
          <Text
            variant="label"
            color={color}
            tabular={column.align === "right"}
            style={{
              textAlign: column.align,
              fontWeight: cell?.bold === true ? "600" : "400",
              flexShrink: 1,
            }}
          >
            {text}
          </Text>
        );
        const content =
          cell?.icon === undefined ? (
            label
          ) : (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.xs,
                justifyContent:
                  column.align === "right" ? "flex-end" : column.align === "center" ? "center" : "flex-start",
              }}
            >
              <BrandIcon name={cell.icon} size={ICON_SIZE} color={colors[color]} />
              {text.length > 0 && label}
            </View>
          );
        const style = {
          width: widths[c],
          paddingVertical: spacing.sm,
          paddingLeft: c === 0 ? 0 : spacing.sm,
          paddingRight: c === last ? 0 : spacing.sm,
        };
        const url = cell?.url;
        return url === undefined ? (
          <View key={c} style={style}>
            {content}
          </View>
        ) : (
          <Pressable
            key={c}
            accessibilityRole="link"
            onPress={() => {
              openExternal(url);
            }}
            style={({ pressed }) => [style, { opacity: pressed ? 0.6 : 1 }]}
          >
            {content}
          </Pressable>
        );
      })}
    </View>
  );
}
