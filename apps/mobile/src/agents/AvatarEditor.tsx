/**
 * The ```openui AvatarEditor widget on the phone: an animated preview (Idle or Talking), the
 * DiceBear style, shuffle, a picker per part with thumbnails, colors, Save and Cancel. The model is
 * `@relay/portrait-motion`'s editor (shared with desktop); everything draws locally with Skia.
 * Save sends `Save my avatar: {json}` as the user's next turn through the widget actions.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import {
  ACCENT_SWATCHES,
  COLOR_ROWS,
  PAPER_SWATCHES,
  PART_DEFS,
  PORTRAIT_STYLES,
  colorValue,
  partChoices,
  partThumbSvg,
  partValue,
  pinPortrait,
  saveMessage,
  shortName,
  shuffle,
  shufflePart,
  withColor,
  withPalette,
  withPart,
  withStyle,
  IDLE_SIGNALS,
  type PartDef,
  type Portrait as EditPortrait,
} from "@relay/portrait-motion";
import { loadSkia } from "@/dictation/skia";
import { radii, spacing, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { Chip } from "@/ui/Chip";
import { AnimatedPortrait } from "@/ui/AnimatedPortrait";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { Text } from "@/ui/Text";
import { useWidgetActions, useWidgetClose } from "./WidgetActions";
import type { AvatarEditorSpec } from "./widget";

const PREVIEW = 144;
const THUMB = 64;
const SWATCH = 28;
const STYLE_TABS = PORTRAIT_STYLES.map((key) => ({ key, label: key === "micah" ? "Micah" : "Notionists" }));
const FACE_TABS = [
  { key: "idle", label: "Idle" },
  { key: "talking", label: "Talking" },
] as const;

export function AvatarEditor({ spec }: { spec: AvatarEditorSpec }) {
  const actions = useWidgetActions();
  const close = useWidgetClose();
  const start = useMemo(() => pinPortrait(spec.current as EditPortrait), [spec.current]);
  const [draft, setDraft] = useState<EditPortrait>(start);
  const [face, setFace] = useState<"idle" | "talking">("idle");
  const [partKey, setPartKey] = useState("hair");
  const [sent, setSent] = useState(false);
  const defs = PART_DEFS[draft.style];
  const def = defs.find((d) => d.key === partKey) ?? defs[0]!;
  const changed = JSON.stringify(draft) !== JSON.stringify(start);

  return (
    <View style={{ gap: spacing.md }} testID="avatar-editor">
      <SegmentedTabs
        tabs={STYLE_TABS}
        value={draft.style}
        onChange={(style) => {
          setDraft(withStyle(draft, style));
          setPartKey(PART_DEFS[style][0]!.key);
        }}
      />
      <View style={{ alignItems: "center", gap: spacing.sm }}>
        <AnimatedPortrait
          name={spec.agent}
          portrait={draft}
          size={PREVIEW}
          signals={IDLE_SIGNALS}
          face={face}
        />
        <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
          <View style={{ width: 160 }}>
            <SegmentedTabs tabs={FACE_TABS} value={face} onChange={setFace} />
          </View>
          <Chip
            label="Shuffle"
            onPress={() => {
              setDraft(shuffle(draft));
            }}
          />
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }}>
        {defs.map((d) => (
          <Chip
            key={d.key}
            label={d.label}
            selected={d.key === def.key}
            onPress={() => {
              setPartKey(d.key);
            }}
          />
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text variant="caption" color="textMuted">{`${def.label}: ${shortName(partValue(draft, def.key))}`}</Text>
        <Chip
          label="Shuffle part"
          onPress={() => {
            setDraft(shufflePart(draft, def.key));
          }}
        />
      </View>
      <Thumbs
        draft={draft}
        def={def}
        onPick={(v) => {
          setDraft(withPart(draft, def.key, v));
        }}
      />
      {COLOR_ROWS[draft.style].map((row) => (
        <Swatches
          key={row.key}
          label={row.label}
          colors={row.swatches.map((c) => `#${c}`)}
          value={colorValue(draft, row.key)}
          onPick={(c) => {
            setDraft(withColor(draft, row.key, c));
          }}
        />
      ))}
      <Swatches
        label="Background"
        colors={PAPER_SWATCHES}
        value={draft.colors?.paper ?? null}
        onPick={(c) => {
          setDraft(withPalette(draft, "paper", c));
        }}
      />
      <Swatches
        label="Accent"
        colors={ACCENT_SWATCHES}
        value={draft.colors?.accent ?? null}
        onPick={(c) => {
          setDraft(withPalette(draft, "accent", c));
        }}
      />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: spacing.sm }}>
        {sent ? (
          <Text variant="caption" color="textMuted">
            Sent
          </Text>
        ) : null}
        <Button
          label="Cancel"
          variant="ghost"
          disabled={sent || (close === null && !changed)}
          onPress={() => {
            // An editor the header opened closes; one the assistant wrote just goes back to its start.
            if (close === null) setDraft(start);
            else close();
          }}
        />
        <Button
          label="Save"
          testID="avatar-editor-save"
          disabled={sent || actions === null || !changed}
          onPress={() => {
            actions?.reply(saveMessage(spec.agent, draft));
            setSent(true);
            close?.();
          }}
        />
      </View>
    </View>
  );
}

/** A strip of every variant of one part, each on the rest of the face; the pick is outlined. */
function Thumbs({ draft, def, onPick }: { draft: EditPortrait; def: PartDef; onPick: (value: string | null) => void }) {
  const colors = useColors();
  const sk = loadSkia();
  const now = partValue(draft, def.key);
  const rest = JSON.stringify([draft.style, draft.seed, withPart(draft, def.key, null).options]);
  const cells = useMemo(
    () =>
      partChoices(draft.style, def.key).map((value) => ({
        value,
        svg: sk === null ? null : sk.Skia.SVG.MakeFromString(partThumbSvg(draft, def, value).replace(/<metadata[\s\S]*?<\/metadata>/, "")),
      })),
    // `rest` names everything the thumbnails read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sk, rest, def.key],
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
      {cells.map(({ value, svg }) => (
        <Pressable
          key={value ?? "none"}
          accessibilityRole="button"
          accessibilityLabel={`${def.label} ${shortName(value)}`}
          accessibilityState={{ selected: value === now }}
          onPress={() => {
            onPick(value);
          }}
          style={{
            alignItems: "center",
            gap: 2,
            padding: spacing.xs,
            borderRadius: radii.sm,
            borderWidth: value === now ? 2 : 1,
            borderColor: value === now ? colors.accent : colors.hairline,
          }}
        >
          <View style={{ width: THUMB, height: THUMB, borderRadius: radii.sm, overflow: "hidden", backgroundColor: draft.colors?.paper ?? "#f1f3f5" }}>
            {sk !== null && svg !== null ? (
              <sk.Canvas style={{ width: THUMB, height: THUMB }}>
                <sk.ImageSVG svg={svg} x={0} y={0} width={THUMB} height={THUMB} />
              </sk.Canvas>
            ) : null}
          </View>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {shortName(value)}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Swatches({
  label,
  colors: choices,
  value,
  onPick,
}: {
  label: string;
  colors: readonly string[];
  value: string | null;
  onPick: (hex: string) => void;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="caption" color="textMuted">
        {label}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
        {choices.map((c) => {
          const on = value?.toLowerCase() === c.toLowerCase();
          return (
            <Pressable
              key={c}
              accessibilityRole="button"
              accessibilityLabel={`${label} ${c}`}
              accessibilityState={{ selected: on }}
              onPress={() => {
                onPick(c);
              }}
              style={{
                width: SWATCH,
                height: SWATCH,
                borderRadius: SWATCH / 2,
                backgroundColor: c,
                borderWidth: on ? 3 : 1,
                borderColor: on ? colors.accent : colors.hairline,
              }}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}
