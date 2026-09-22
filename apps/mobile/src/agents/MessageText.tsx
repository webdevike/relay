/** Transcript text rendered from Markdown: headings, emphasis, lists, tables, blockquotes,
 * links, inline code, and fenced blocks (CodeBlock). */
import { Fragment } from "react";
import { Linking, Platform, Text as RNText, ScrollView, type TextStyle, View } from "react-native";
import { colors, radii, spacing, type } from "@/theme";
import { Text } from "@/ui/Text";
import { CodeBlock } from "./CodeBlock";
import { type Align, type Block, type Inline, parseBlocks } from "./markdown";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

/** Heading point sizes, largest at #, tapering to body by ####+. */
const HEADING_SIZE = [22, 20, 18, 16, 15, 15];

/** Fixed column width so wide tables overflow into the horizontal scroll instead of crushing. */
const COL_WIDTH = 140;

export interface MessageTextProps {
  text: string;
}

export function MessageText({ text }: MessageTextProps) {
  return (
    <View style={{ gap: spacing.sm }}>
      {parseBlocks(text).map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </View>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "code":
      return <CodeBlock code={block.code} lang={block.lang} />;
    case "hr":
      return <View style={{ height: 1, backgroundColor: colors.hairline, marginVertical: spacing.xs }} />;
    case "heading": {
      const size = HEADING_SIZE[block.level - 1] ?? 15;
      return (
        <RNText style={{ fontSize: size, lineHeight: Math.round(size * 1.3), fontWeight: "700", color: colors.text }}>
          <Inlines runs={block.inline} />
        </RNText>
      );
    }
    case "paragraph":
      return (
        <RNText style={{ fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, color: colors.text }}>
          <Inlines runs={block.inline} />
        </RNText>
      );
    case "blockquote":
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: colors.hairline, paddingLeft: spacing.md, gap: spacing.sm }}>
          {block.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </View>
      );
    case "list":
      return <ListView block={block} />;
    case "table":
      return <TableView block={block} />;
  }
}

function ListView({ block }: { block: Extract<Block, { kind: "list" }> }) {
  return (
    <View style={{ gap: spacing.xs }}>
      {block.items.map((item, i) => (
        <View key={i} style={{ flexDirection: "row" }}>
          <RNText style={{ fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, color: colors.textMuted, width: block.ordered ? 24 : 16 }}>
            {block.ordered ? `${block.start + i}.` : "•"}
          </RNText>
          <View style={{ flex: 1, gap: spacing.xs }}>
            {item.blocks.map((b, j) => (
              <BlockView key={j} block={b} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const justify: Record<Exclude<Align, null>, "flex-start" | "center" | "flex-end"> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

function TableView({ block }: { block: Extract<Block, { kind: "table" }> }) {
  const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ borderWidth: 1, borderColor: colors.hairline, borderRadius: radii.md, overflow: "hidden", alignSelf: "flex-start" }}>
        <TableRow cells={block.header} columns={columns} align={block.align} header />
        {block.rows.map((row, i) => (
          <TableRow key={i} cells={row} columns={columns} align={block.align} />
        ))}
      </View>
    </ScrollView>
  );
}

function TableRow({ cells, columns, align, header = false }: { cells: Inline[][]; columns: number; align: Align[]; header?: boolean }) {
  return (
    <View style={{ flexDirection: "row", backgroundColor: header ? colors.surfaceRaised : undefined, borderTopWidth: header ? 0 : 1, borderTopColor: colors.hairline }}>
      {Array.from({ length: columns }, (_, c) => (
        <View key={c} style={{ width: COL_WIDTH, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderLeftWidth: c === 0 ? 0 : 1, borderLeftColor: colors.hairline, alignItems: justify[align[c] ?? "left"] }}>
          <RNText style={{ fontSize: type.caption.fontSize, lineHeight: type.caption.lineHeight, color: colors.text, fontWeight: header ? "600" : "400" }}>
            <Inlines runs={cells[c] ?? []} />
          </RNText>
        </View>
      ))}
    </View>
  );
}

function Inlines({ runs }: { runs: Inline[] }) {
  return (
    <Fragment>
      {runs.map((run, i) => {
        const style: TextStyle = {};
        if (run.bold === true) style.fontWeight = "700";
        if (run.italic === true) style.fontStyle = "italic";
        if (run.strike === true) style.textDecorationLine = "line-through";
        if (run.code === true) {
          style.fontFamily = mono;
          style.fontSize = 13;
          style.backgroundColor = colors.surfaceRaised;
        }
        if (run.href !== undefined) {
          style.color = colors.accent;
          if (run.code !== true) style.textDecorationLine = run.strike === true ? "underline line-through" : "underline";
        }
        const href = run.href;
        return (
          <RNText key={i} style={style} onPress={href === undefined ? undefined : () => void Linking.openURL(href)}>
            {run.text}
          </RNText>
        );
      })}
    </Fragment>
  );
}
