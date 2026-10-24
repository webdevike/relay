/** Transcript text rendered from Markdown: headings, emphasis, lists, tables, blockquotes,
 * links, images, inline code, and fenced blocks (CodeBlock). */
import { Fragment, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Platform, Text as RNText, ScrollView, type TextStyle, View } from "react-native";
import Animated, { FadeIn, ReduceMotion, useReducedMotion } from "react-native-reanimated";
import { openExternal } from "@/lib/links";
import { motion, radii, spacing, type, useColors } from "@/theme";
import { BlockQuote } from "@/ui/BlockQuote";
import { ListItem } from "@/ui/ListItem";
import { CodeBlock } from "./CodeBlock";
import { MarkdownImages } from "./MarkdownImages";
import { HtmlWidget } from "./HtmlWidget";
import { type Align, type Block, type Inline, type MessageImage, parseBlocks } from "./markdown";
import { openUIView, syncOpenUIRuntime } from "./openui";
import { OpenUIRuntimeContext } from "./OpenUIRuntime";
import { Widget } from "./Widget";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

/** Heading point sizes, largest at #, tapering to body by ####+. */
const HEADING_SIZE = [24, 22, 20, 18, 17, 17];

/** Fixed column width so wide tables overflow into the horizontal scroll instead of crushing. */
const COL_WIDTH = 140;

export interface MessageTextProps {
  text: string;
  /** Chat-sized body text (17pt) for a transcript that sits on the page itself; default is the 15pt body. */
  large?: boolean;
  /** Leave the top-level images out: the caller shows them itself (`topLevelImages` + `MarkdownImages`), e.g. above a bubble. */
  skipImages?: boolean;
  /** Animate only appended blocks and inline tails while a live reply grows. Existing content stays still. */
  streaming?: boolean;
}

/** Comfortable transcript measure without changing the smaller default body style. */
export const LARGE_BODY = { fontSize: 17, lineHeight: 26 } as const;
/** Width of a list's marker column (bullet or number), which is also the indent of the item text. */
const LIST_INDENT = 20;
const BULLET = 6;

export function MessageText({ text, large = false, skipImages = false, streaming = false }: MessageTextProps) {
  const body = large ? LARGE_BODY : type.body;
  const reducedMotion = useReducedMotion();
  // Images in a row share one tile stack (and one viewer), so they page together.
  const rows = useMemo(() => {
    const result: (Block | { kind: "images"; images: MessageImage[] })[] = [];
    for (const block of parseBlocks(text)) {
      if (block.kind !== "image") {
        result.push(block);
        continue;
      }
      if (skipImages) continue;
      const last = result[result.length - 1];
      if (last?.kind === "images") last.images.push({ src: block.src, alt: block.alt });
      else result.push({ kind: "images", images: [{ src: block.src, alt: block.alt }] });
    }
    return result;
  }, [text, skipImages]);
  const previous = useRef({ text, count: rows.length, streaming });
  const appending = streaming && previous.current.streaming && text.startsWith(previous.current.text);
  useLayoutEffect(() => {
    previous.current = { text, count: rows.length, streaming };
  }, [text, rows.length, streaming]);
  return (
    <View>
      {rows.map((row, i) => (
        <Animated.View
          key={i}
          {...(appending && i >= previous.current.count && !reducedMotion ? { entering: FadeIn.duration(motion.duration.base).reduceMotion(ReduceMotion.System) } : {})}
          style={{ marginTop: i === 0 ? 0 : row.kind === "heading" ? spacing.xl : rows[i - 1]?.kind === "heading" ? spacing.sm : spacing.md }}
        >
          {row.kind === "images" ? <MarkdownImages images={row.images} /> : <BlockView block={row} body={body} streaming={streaming && !reducedMotion} />}
        </Animated.View>
      ))}
    </View>
  );
}

interface BodySize {
  fontSize: number;
  lineHeight: number;
}

function BlockView({ block, body, streaming = false }: { block: Block; body: BodySize; streaming?: boolean }) {
  const colors = useColors();
  switch (block.kind) {
    case "code":
      return <CodeBlock code={block.code} lang={block.lang} invalid={block.invalid} />;
    case "hr":
      return <View style={{ height: 1, backgroundColor: colors.hairline, marginVertical: spacing.xs }} />;
    case "heading": {
      const size = HEADING_SIZE[block.level - 1] ?? 15;
      return (
        <RNText accessibilityRole="header" style={{ fontSize: size, lineHeight: Math.round(size * 1.3), fontWeight: "600", color: colors.text }}>
          <Inlines runs={block.inline} streaming={streaming} fontSize={size} />
        </RNText>
      );
    }
    case "paragraph":
      return (
        <RNText style={{ fontSize: body.fontSize, lineHeight: body.lineHeight, color: colors.text }}>
          <Inlines runs={block.inline} streaming={streaming} fontSize={body.fontSize} />
        </RNText>
      );
    case "blockquote":
      return (
        <BlockQuote>
          {block.blocks.map((b, i) => (
            <BlockView key={i} block={b} body={body} streaming={streaming} />
          ))}
        </BlockQuote>
      );
    case "list":
      return <ListView block={block} body={body} streaming={streaming} />;
    case "table":
      return <TableView block={block} />;
    case "widget":
      return <Widget spec={block.spec} />;
    case "openui":
      return <OpenUIBlock code={block.code} partial={block.partial} />;
    case "html":
      return <HtmlWidget code={block.html} runtime="html" partial={block.partial} fontSize={body.fontSize} lineHeight={body.lineHeight} />;
    case "mantine":
      return <HtmlWidget code={block.code} runtime="mantine" partial={block.partial} fontSize={body.fontSize} lineHeight={body.lineHeight} />;
    case "image":
      return <MarkdownImages images={[{ src: block.src, alt: block.alt }]} />;
  }
}

/**
 * A ```openui fence drawn live. It owns the fence's runtime while mounted (blocks are keyed by
 * position inside a message keyed by id), feeds it every streamed version of the text, and redraws
 * the widget whenever its `$variable` state changes.
 */
function OpenUIBlock({ code, partial }: { code: string; partial: boolean }) {
  const [{ runtime, subscribe, getSnapshot }] = useState(() => {
    const created = syncOpenUIRuntime(null, code, partial);
    return { runtime: created, subscribe: (cb: () => void) => created.subscribe(cb), getSnapshot: () => created.snapshot() };
  });
  // Before paint, so a streamed chunk never shows a frame of the previous text.
  useLayoutEffect(() => {
    syncOpenUIRuntime(runtime, code, partial);
  }, [runtime, code, partial]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const view = openUIView(snapshot, partial);
  if (view.kind === "code") return <CodeBlock code={code} lang="openui" invalid={view.invalid} />;
  return (
    <OpenUIRuntimeContext.Provider value={runtime}>
      <Widget spec={view.spec} />
    </OpenUIRuntimeContext.Provider>
  );
}

function ListView({ block, body, streaming }: { block: Extract<Block, { kind: "list" }>; body: BodySize; streaming: boolean }) {
  const colors = useColors();
  return (
    <View style={{ gap: spacing.sm }}>
      {block.items.map((item, i) => (
        <ListItem
          key={i}
          markerWidth={LIST_INDENT}
          marker={
            block.ordered ? (
              <RNText style={{ fontSize: body.fontSize, lineHeight: body.lineHeight, color: colors.text }}>{`${block.start + i}.`}</RNText>
            ) : (
              <View style={{ width: BULLET, height: BULLET, borderRadius: BULLET / 2, backgroundColor: colors.text, marginTop: (body.lineHeight - BULLET) / 2 }} />
            )
          }
        >
          <View style={{ gap: spacing.sm }}>
            {item.blocks.map((b, j) => (
              <BlockView key={j} block={b} body={body} streaming={streaming} />
            ))}
          </View>
        </ListItem>
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
  const colors = useColors();
  const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length));
  return (
    <ScrollView horizontal style={{ flexGrow: 0 }} showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
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
  const colors = useColors();
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

function Inlines({ runs, streaming = false, fontSize = type.body.fontSize }: { runs: Inline[]; streaming?: boolean; fontSize?: number }) {
  const colors = useColors();
  return (
    <Fragment>
      {runs.map((run, i) => {
        const style: TextStyle = {};
        if (run.bold === true) style.fontWeight = "600";
        if (run.italic === true) style.fontStyle = "italic";
        if (run.strike === true) style.textDecorationLine = "line-through";
        if (run.code === true) {
          style.fontFamily = mono;
          style.fontSize = Math.round(fontSize * 0.88);
          style.color = colors.text;
          style.backgroundColor = colors.surfaceRaised;
        }
        if (run.href !== undefined) {
          style.color = colors.accent;
          if (run.code !== true) style.textDecorationLine = run.strike === true ? "underline line-through" : "underline";
        }
        const href = run.href;
        return (
          <RNText key={i} style={style} accessibilityRole={href === undefined ? undefined : "link"} onPress={href === undefined ? undefined : () => { openExternal(href); }}>
            {streaming ? <InlineContent text={run.text} /> : run.text}
          </RNText>
        );
      })}
    </Fragment>
  );
}

interface TextChunk {
  id: number;
  text: string;
  addedAt: number;
}

/** Keep animated tails mounted as tokens arrive; merge only tails whose fade has finished. */
function InlineContent({ text }: { text: string }) {
  const [content, setContent] = useState(() => ({
    text,
    chunks: [{ id: 0, text, addedAt: 0 }] as TextChunk[],
    nextId: 1,
  }));
  if (text !== content.text) {
    const now = Date.now();
    const append = text.startsWith(content.text);
    const settled: TextChunk = { id: 0, text: "", addedAt: 0 };
    const chunks: TextChunk[] = [settled];
    if (append) {
      for (const chunk of content.chunks) {
        if (now - chunk.addedAt >= motion.duration.base) settled.text += chunk.text;
        else chunks.push(chunk);
      }
      const tail = text.slice(content.text.length);
      if (tail) chunks.push({ id: content.nextId, text: tail, addedAt: now });
    } else {
      settled.text = text;
    }
    setContent({ text, chunks, nextId: content.nextId + 1 });
  }
  return (
    <Fragment>
      {content.chunks.map((chunk) => chunk.id === 0 ? (
        <RNText key={chunk.id}>{chunk.text}</RNText>
      ) : (
        <Animated.Text key={chunk.id} entering={FadeIn.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}>
          {chunk.text}
        </Animated.Text>
      ))}
    </Fragment>
  );
}
