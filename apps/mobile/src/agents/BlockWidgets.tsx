/**
 * The design-system leaves of the ```ui catalogue (button, table, progress, list, code, quote,
 * avatar, timeline). Each wires its spec to primitives in `src/ui/`; layout only.
 */
import { View } from "react-native";
import { openExternal } from "@/lib/links";
import { spacing } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { BlockQuote } from "@/ui/BlockQuote";
import { Button, type ButtonVariant } from "@/ui/Button";
import { CheckMark } from "@/ui/CheckMark";
import { DataTable, type DataCell, type DataColumn } from "@/ui/DataTable";
import { ListItem } from "@/ui/ListItem";
import { ProgressBar } from "@/ui/ProgressBar";
import { Text } from "@/ui/Text";
import { TimelineItem } from "@/ui/TimelineItem";
import { CodeBlock } from "./CodeBlock";
import { useDropSrc } from "./dropSrc";
import { toneColor } from "./tone";
import { useWidgetActions } from "./WidgetActions";
import type {
  AvatarSpec,
  ButtonSpec,
  CodeSpec,
  ListSpec,
  ProgressSpec,
  QuoteSpec,
  TableSpec,
  TimelineSpec,
} from "./widget";

const buttonVariant: Record<ButtonSpec["variant"], ButtonVariant> = {
  primary: "primary",
  secondary: "secondary",
  subtle: "ghost",
};

/** A `url` opens externally; a `reply` goes to the session as its next turn, so with no session
 * to reply to the button is disabled. Subtle buttons default to a muted label. */
export function ButtonWidget({ spec }: { spec: ButtonSpec }) {
  const actions = useWidgetActions();
  const { url, reply } = spec;
  return (
    <Button
      label={spec.label}
      variant={buttonVariant[spec.variant]}
      tone={
        spec.tone !== undefined
          ? toneColor[spec.tone]
          : spec.variant === "subtle"
            ? "textMuted"
            : undefined
      }
      disabled={url === undefined && actions === null}
      onPress={() => {
        if (url !== undefined) openExternal(url);
        else if (reply !== undefined) actions?.reply(reply);
      }}
    />
  );
}

export function TableWidget({ spec }: { spec: TableSpec }) {
  const columns = spec.columns.map(
    (column): DataColumn =>
      typeof column === "string"
        ? { label: column, align: "left" }
        : { label: column.label, align: column.align ?? "left" },
  );
  const rows = spec.rows.map((row) =>
    row.map(
      (cell): DataCell =>
        typeof cell === "string"
          ? { text: cell }
          : typeof cell === "number"
            ? { text: String(cell) }
            : {
                text: cell.text,
                color: cell.tone === undefined ? undefined : toneColor[cell.tone],
                bold: cell.bold,
              },
    ),
  );
  return (
    <View style={{ gap: spacing.xs }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <DataTable columns={columns} rows={rows} />
    </View>
  );
}

export function ProgressWidget({ spec }: { spec: ProgressSpec }) {
  const fraction = spec.value / spec.max;
  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
        <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
          {spec.label ?? ""}
        </Text>
        <Text variant="caption" color="textMuted" tabular>
          {`${Math.round(fraction * 100)}%`}
        </Text>
      </View>
      <ProgressBar fraction={fraction} tone={toneColor[spec.tone]} />
      {spec.caption !== undefined && (
        <Text variant="caption" color="textMuted">
          {spec.caption}
        </Text>
      )}
    </View>
  );
}

/** Check marks are static here: they report state, they don't toggle it. */
export function ListWidget({ spec }: { spec: ListSpec }) {
  const numbered = spec.style === "number";
  return (
    <View style={{ gap: spacing.xs }}>
      {spec.items.map((item, i) => {
        const { text, caption, checked } = typeof item === "string" ? { text: item } : item;
        const done = spec.style === "check" && checked === true;
        return (
          <ListItem
            key={i}
            markerWidth={spec.style === "bullet" ? 16 : 24}
            marker={
              spec.style === "check" ? (
                <View style={{ paddingTop: 2 }}>
                  <CheckMark checked={done} size={16} />
                </View>
              ) : (
                <Text color="textMuted" tabular={numbered}>
                  {numbered ? `${i + 1}.` : "•"}
                </Text>
              )
            }
          >
            <Text
              color={done ? "textMuted" : "text"}
              style={done ? { textDecorationLine: "line-through" } : undefined}
            >
              {text}
            </Text>
            {caption !== undefined && (
              <Text variant="caption" color="textMuted">
                {caption}
              </Text>
            )}
          </ListItem>
        );
      })}
    </View>
  );
}

export function CodeWidget({ spec }: { spec: CodeSpec }) {
  return (
    <View style={{ gap: spacing.xs }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <CodeBlock code={spec.code} lang={spec.language ?? null} />
    </View>
  );
}

export function QuoteWidget({ spec }: { spec: QuoteSpec }) {
  return (
    <BlockQuote>
      <Text>{spec.text}</Text>
      {spec.cite !== undefined && (
        <Text variant="caption" color="textMuted">
          {spec.cite}
        </Text>
      )}
    </BlockQuote>
  );
}

export function AvatarWidget({ spec }: { spec: AvatarSpec }) {
  // Drop paths resolve against the connected host; until then (or with no photo) initials show.
  const [uri] = useDropSrc(spec.src === undefined ? [] : [spec.src]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <Avatar name={spec.name} uri={uri} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" style={{ fontWeight: "600" }} numberOfLines={1}>
          {spec.name}
        </Text>
        {spec.subtitle !== undefined && (
          <Text variant="caption" color="textMuted" numberOfLines={2}>
            {spec.subtitle}
          </Text>
        )}
      </View>
    </View>
  );
}

export function TimelineWidget({ spec }: { spec: TimelineSpec }) {
  return (
    <View>
      {spec.items.map((item, i) => (
        <TimelineItem
          key={i}
          title={item.title}
          time={item.time}
          text={item.text}
          color={item.tone === undefined ? "textFaint" : toneColor[item.tone]}
          last={i === spec.items.length - 1}
        />
      ))}
    </View>
  );
}
