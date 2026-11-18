/**
 * What the work sheet shows (`TurnWorkSheet`): a header (`Working` with the elapsed clock and the tool count
 * while the turn runs, `Thought 12s` and the count once done), the turn's thinking (an excerpt, the whole of
 * it on a tap) and its tool steps on a rail: glyph, title, tool and input line, time, and on a tap the step's
 * full input and output, fetched then. Pure layout over the sheet machine's state.
 */
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text as RNText,
  StyleSheet,
  View,
} from "react-native";
import { SymbolView } from "expo-symbols";
import {
  THINKING_DETAIL,
  workClock,
  workDuration,
  workHeader,
  type TurnStep,
  type TurnWork,
  type TurnWorkDetail,
} from "@relay/protocol";
import type { PartState } from "@/agents/turnWork.machine";
import { tapHaptic } from "@/lib/haptics";
import { detailLines, stepView } from "@/lib/turnWork";
import { radii, spacing, useColors } from "@/theme";
import { BrainIcon } from "@/ui/BrainIcon";
import { Button } from "@/ui/Button";
import { Pulse } from "@/ui/Pulse";
import { Text } from "@/ui/Text";
import { toolGlyph } from "./ToolRow";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });
const GLYPH = 15;
/** The rail's column: the glyph and the hairline that joins it to the next step. */
const RAIL = 22;

export type SheetState = "loading" | "shown" | "failed";

export function TurnWorkHeader({
  state,
  work,
  now,
}: {
  state: SheetState;
  work: TurnWork | null;
  now: number;
}) {
  const colors = useColors();
  const head =
    work === null
      ? { title: state === "failed" ? "Work" : "Loading", meta: "" }
      : workHeader(work, now);
  return (
    <View style={[styles.head, { borderBottomColor: colors.hairline }]} testID="work-sheet-header">
      <Text variant="title" numberOfLines={1} style={styles.headTitle}>
        {head.title}
      </Text>
      {head.meta !== "" && (
        <Text variant="caption" color="textMuted" tabular>
          {head.meta}
        </Text>
      )}
    </View>
  );
}

export interface TurnWorkBodyProps {
  state: SheetState;
  work: TurnWork | null;
  error: string | null;
  parts: Readonly<Record<string, PartState>>;
  open: readonly string[];
  now: number;
  onToggle: (id: string) => void;
  onRetry: () => void;
}

export function TurnWorkBody({
  state,
  work,
  error,
  parts,
  open,
  now,
  onToggle,
  onRetry,
}: TurnWorkBodyProps) {
  if (state === "loading" || work === null) {
    if (state === "failed")
      return (
        <View style={styles.failed}>
          <Text variant="body" color="textMuted">
            {error ?? "Nothing to show for this turn."}
          </Text>
          <Button label="Try again" variant="secondary" onPress={onRetry} />
        </View>
      );
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }
  const thinkingNow = work.now?.kind === "model";
  const showThinking = work.thinking !== undefined || thinkingNow;
  return (
    <View style={styles.body} testID="work-sheet">
      {showThinking && (
        <ThinkingRow
          work={work}
          now={now}
          open={open.includes(THINKING_DETAIL)}
          part={parts[THINKING_DETAIL]}
          last={work.steps.length === 0}
          onToggle={onToggle}
        />
      )}
      {work.earlier !== undefined && (
        <Text variant="caption" color="textFaint" style={styles.earlier}>
          {work.earlier === 1 ? "1 earlier step" : `${String(work.earlier)} earlier steps`}
        </Text>
      )}
      {work.steps.map((step, i) => (
        <StepRow
          key={step.id}
          step={step}
          now={now}
          last={i === work.steps.length - 1}
          open={open.includes(step.id)}
          part={parts[step.id]}
          onToggle={onToggle}
        />
      ))}
      {!showThinking && work.steps.length === 0 && (
        <Text variant="body" color="textMuted">
          {work.running ? "Starting…" : "No thinking or tools in this turn."}
        </Text>
      )}
    </View>
  );
}

/** The glyph column of a row: its glyph, and the hairline down to the next row unless it is the last. */
function Rail({ children, last }: { children: ReactNode; last: boolean }) {
  const colors = useColors();
  return (
    <View style={styles.rail}>
      <View style={styles.glyph}>{children}</View>
      {!last && <View style={[styles.line, { backgroundColor: colors.hairline }]} />}
    </View>
  );
}

function ThinkingRow({
  work,
  now,
  open,
  part,
  last,
  onToggle,
}: {
  work: TurnWork;
  now: number;
  open: boolean;
  part: PartState | undefined;
  last: boolean;
  onToggle: (id: string) => void;
}) {
  const colors = useColors();
  const since = work.now?.kind === "model" ? work.now.since : null;
  const title =
    since !== null
      ? `Thinking · ${workClock(now - since)}`
      : `Thought for ${workDuration(work.modelMs)}`;
  const excerpt = work.thinking?.excerpt;
  return (
    <View style={styles.row}>
      <Rail last={last}>
        <Pulse active={since !== null}>
          <BrainIcon size={GLYPH} color={since !== null ? colors.accent : colors.textMuted} />
        </Pulse>
      </Rail>
      <Pressable
        style={styles.main}
        disabled={excerpt === undefined}
        accessibilityRole="button"
        accessibilityLabel={open ? "Show less of the thinking" : "Show all of the thinking"}
        onPress={() => {
          tapHaptic();
          onToggle(THINKING_DETAIL);
        }}
        testID="work-thinking"
      >
        <Text variant="body">{title}</Text>
        {excerpt !== undefined && !open && (
          <Text variant="body" color="textMuted" numberOfLines={3} style={styles.thinking}>
            {excerpt}
          </Text>
        )}
        {open && (
          <PartText
            part={part}
            render={(detail) => (
              <Text variant="body" color="textMuted" style={styles.thinking} selectable>
                {detail.text ?? ""}
              </Text>
            )}
          />
        )}
      </Pressable>
    </View>
  );
}

function StepRow({
  step,
  now,
  last,
  open,
  part,
  onToggle,
}: {
  step: TurnStep;
  now: number;
  last: boolean;
  open: boolean;
  part: PartState | undefined;
  onToggle: (id: string) => void;
}) {
  const colors = useColors();
  const view = stepView(step, now);
  const glyph =
    step.status === "running" ? (
      <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />
    ) : (
      <SymbolView
        name={toolGlyph(step.tool)}
        size={GLYPH - 1}
        tintColor={step.status === "failed" ? colors.danger : colors.textMuted}
        weight="medium"
      />
    );
  return (
    <View style={styles.row}>
      <Rail last={last}>{glyph}</Rail>
      <View style={styles.main}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${view.title}, ${view.tool}${view.time === "" ? "" : `, ${view.time}`}${step.status === "failed" ? ", failed" : step.status === "running" ? ", running" : ""}`}
          accessibilityHint={open ? "Hides its input and output" : "Shows its input and output"}
          onPress={() => {
            tapHaptic();
            onToggle(step.id);
          }}
          testID={`work-step-${step.id}`}
        >
          <View style={styles.titleRow}>
            <Text variant="body" numberOfLines={1} style={styles.stepTitle}>
              {view.title}
            </Text>
            {view.time !== "" && (
              <Text
                variant="caption"
                color={step.status === "running" ? "accent" : "textFaint"}
                tabular
              >
                {view.time}
              </Text>
            )}
            <SymbolView
              name={open ? "chevron.down" : "chevron.right"}
              size={11}
              tintColor={colors.textFaint}
              weight="medium"
            />
          </View>
          <Text variant="caption" color="textFaint" numberOfLines={1}>
            <Text variant="caption" color="textMuted" style={styles.tool}>
              {view.tool}
            </Text>
            {view.summary === "" ? "" : ` · ${view.summary}`}
          </Text>
          {view.error !== null && (
            <Text variant="caption" color="danger" numberOfLines={1}>
              {view.error}
            </Text>
          )}
        </Pressable>
        {open && (
          <View
            style={[styles.detail, { borderColor: colors.hairline }]}
            testID={`work-detail-${step.id}`}
          >
            <PartText
              part={part}
              render={(detail) => (
                <>
                  <DetailSection label="Input" tool={step.tool} text={detail.input ?? ""} />
                  {step.status === "running" && detail.output === undefined ? null : (
                    <DetailSection
                      label={detail.failed === true ? "Error" : "Output"}
                      tool={step.tool}
                      text={detail.output ?? "(no output yet)"}
                      divided
                    />
                  )}
                  {detail.truncated === true && (
                    <Text variant="caption" color="textFaint" style={styles.section}>
                      Cut short: the rest stays on your Mac.
                    </Text>
                  )}
                </>
              )}
            />
          </View>
        )}
      </View>
    </View>
  );
}

/** A part's full text once fetched; a spinner while it comes, the reason when it could not. */
function PartText({
  part,
  render,
}: {
  part: PartState | undefined;
  render: (detail: TurnWorkDetail) => ReactNode;
}) {
  if (part === undefined || part.state === "loading")
    return (
      <View style={styles.partLoading}>
        <ActivityIndicator size="small" />
      </View>
    );
  if (part.state === "failed")
    return (
      <Text variant="caption" color="textMuted" style={styles.section}>
        {`${part.error} Tap again to retry.`}
      </Text>
    );
  return <>{render(part.detail)}</>;
}

function DetailSection({
  label,
  tool,
  text,
  divided = false,
}: {
  label: string;
  tool: string;
  text: string;
  divided?: boolean;
}) {
  const colors = useColors();
  const lines = detailLines(tool, text);
  return (
    <View
      style={[
        styles.section,
        divided && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
      ]}
    >
      <Text variant="caption" color="textFaint" style={styles.label}>
        {label.toUpperCase()}
      </Text>
      <Text selectable style={[styles.mono, { color: colors.text }]}>
        {lines.map((line, i) => (
          <RNText
            key={i}
            style={
              line.tone === "add"
                ? { color: colors.ok }
                : line.tone === "del"
                  ? { color: colors.danger }
                  : undefined
            }
          >
            {i === lines.length - 1 ? line.text : `${line.text}\n`}
          </RNText>
        ))}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headTitle: { flex: 1 },
  body: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xl },
  loading: { paddingVertical: spacing.xxxl, alignItems: "center" },
  failed: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
    gap: spacing.md,
    alignItems: "flex-start",
  },
  earlier: { paddingLeft: RAIL + spacing.md, paddingBottom: spacing.sm },
  row: { flexDirection: "row", gap: spacing.md },
  rail: { width: RAIL, alignItems: "center" },
  glyph: { height: 22, justifyContent: "center", alignItems: "center" },
  line: { width: StyleSheet.hairlineWidth * 2, flex: 1, marginVertical: 2 },
  spinner: { transform: [{ scale: 0.75 }] },
  main: { flex: 1, minWidth: 0, paddingBottom: spacing.lg },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 22 },
  stepTitle: { flex: 1 },
  tool: { fontWeight: "600" },
  thinking: { fontStyle: "italic", marginTop: 2 },
  detail: {
    marginTop: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    overflow: "hidden",
  },
  section: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs },
  label: { letterSpacing: 0.8 },
  mono: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
  partLoading: { paddingVertical: spacing.md, alignItems: "center" },
});
