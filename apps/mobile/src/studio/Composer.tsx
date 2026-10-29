/**
 * Studio's form: prompt, mode, backend (and Higgsfield model), aspect, size, length, seed, and the
 * keyframe or reference slots. Shows the fitted draft (`studioForm`); every change goes back to the
 * store's draft as a patch. Generate lives in the screen's bottom bar, not here.
 */
import { Pressable, View, useWindowDimensions } from "react-native";
import { SymbolView } from "expo-symbols";
import type { StudioAsset, StudioFrameSlot } from "@relay/protocol";
import { spacing, useColors } from "@/theme";
import { ChipRow } from "@/ui/ChipRow";
import { Chip } from "@/ui/Chip";
import { MediaSlot } from "@/ui/MediaSlot";
import { OptionRow } from "@/ui/OptionRow";
import { Pill } from "@/ui/Pill";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { STUDIO_ASPECTS, type StudioDraft, type StudioForm, type StudioTarget } from "./draft";
import type { Quote } from "./quote";

const SLOT_COLUMNS = 3;
const SLOT_NAMES: Record<StudioFrameSlot, string> = { start: "Start", mid: "Mid", end: "End" };
const MODES = [
  { key: "image", label: "Image" },
  { key: "video", label: "Video" },
] as const;

export interface ComposerProps {
  form: StudioForm;
  assets: ReadonlyMap<string, StudioAsset>;
  base: string | null;
  /** The current settings' price on a paid backend, when known. */
  quote: Quote | undefined;
  /** The slot an upload is on its way into. */
  uploading: StudioTarget | null;
  onPatch: (patch: Partial<StudioDraft>) => void;
  onAdd: (target: StudioTarget) => void;
  onOpenAsset: (asset: StudioAsset) => void;
  onOpenModels: () => void;
}

export function Composer({ form, assets, base, quote, uploading, onPatch, onAdd, onOpenAsset, onOpenModels }: ComposerProps) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const slotSize = Math.floor((width - spacing.xl * 2 - spacing.md * (SLOT_COLUMNS - 1)) / SLOT_COLUMNS);
  const { draft, backend } = form;
  const thumb = (id: string | undefined) => {
    const asset = id === undefined ? undefined : assets.get(id);
    return asset === undefined || base === null ? null : `${base}${asset.thumb}`;
  };
  const open = (id: string) => {
    const asset = assets.get(id);
    if (asset !== undefined) onOpenAsset(asset);
  };

  return (
    <View style={{ gap: spacing.lg }}>
      <View style={{ paddingHorizontal: spacing.xl, gap: spacing.md }}>
        <TextField
          value={draft.prompt}
          onChangeText={(prompt) => {
            onPatch({ prompt });
          }}
          placeholder={draft.mode === "image" ? "Describe the image" : "Describe the video"}
          accessibilityLabel="Prompt"
          multiline
        />
        <SegmentedTabs
          tabs={MODES}
          value={draft.mode}
          onChange={(mode) => {
            onPatch({ mode });
          }}
        />
      </View>

      {form.backends.length > 0 && (
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.sm }}>
          {form.backends.map((b) => (
            <OptionRow
              key={b.id}
              label={b.label}
              description={b.available ? undefined : b.reason}
              selected={b.id === backend?.id}
              disabled={!b.available}
              trailing={<Pill label={b.paid ? "Paid" : "Free"} />}
              onPress={() => {
                onPatch({ backend: b.id });
              }}
            />
          ))}
        </View>
      )}

      {form.model !== undefined && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Model, ${form.model.name}`}
          accessibilityHint="Choose a model"
          onPress={onOpenModels}
          style={({ pressed }) => ({
            minHeight: 52,
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.md,
            paddingHorizontal: spacing.xl,
            backgroundColor: pressed ? colors.surfaceRaised : "transparent",
          })}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="caption" color="textMuted">
              Model
            </Text>
            <Text variant="title" numberOfLines={1}>
              {form.model.name}
            </Text>
          </View>
          <Text variant="caption" color="textMuted" tabular>
            {quoteLine(quote, backend?.balance)}
          </Text>
          <SymbolView name="chevron.right" size={13} tintColor={colors.textFaint} />
        </Pressable>
      )}

      <ChipRow
        label="Aspect"
        options={STUDIO_ASPECTS.map((aspect) => ({ key: aspect, label: aspect }))}
        value={draft.aspect}
        onChange={(aspect) => {
          onPatch({ aspect });
        }}
      />
      {form.resolutions.length > 0 && (
        <ChipRow
          label="Size"
          options={form.resolutions.map((r) => ({ key: r.id, label: r.label }))}
          value={draft.resolution}
          onChange={(resolution) => {
            onPatch({ resolution });
          }}
        />
      )}
      {form.seconds.length > 0 && (
        <ChipRow
          label="Length"
          options={form.seconds.map((s) => ({ key: s, label: `${s} s`, accessibilityLabel: `${s} seconds` }))}
          value={draft.seconds}
          onChange={(seconds) => {
            onPatch({ seconds });
          }}
        />
      )}

      {backend?.seed === true && (
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.xs }}>
          <Text variant="caption" color="textMuted">
            Seed
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <TextField
                value={draft.seed === undefined ? "" : String(draft.seed)}
                onChangeText={(text) => {
                  const digits = text.replace(/\D/g, "").slice(0, 10);
                  const seed = digits.length === 0 ? undefined : Math.min(Number(digits), 2_147_483_647);
                  onPatch({ seed });
                }}
                placeholder="Random"
                accessibilityLabel="Seed"
                keyboardType="number-pad"
                returnKeyType="done"
              />
            </View>
            <Chip
              label="Random"
              selected={draft.seed === undefined}
              hitSlop={{ top: 8, bottom: 8 }}
              accessibilityLabel="Random seed"
              onPress={() => {
                onPatch({ seed: undefined });
              }}
            />
          </View>
        </View>
      )}

      {form.slots.length > 0 && (
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.sm }}>
          <Text variant="caption" color="textMuted">
            Keyframes
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
            {form.slots.map((slot) => {
              const id = draft.frames[slot];
              return (
                <MediaSlot
                  key={slot}
                  label={SLOT_NAMES[slot]}
                  size={slotSize}
                  uri={thumb(id)}
                  filled={id !== undefined}
                  busy={uploading === slot}
                  onAdd={() => {
                    onAdd(slot);
                  }}
                  onPress={
                    id === undefined
                      ? undefined
                      : () => {
                          open(id);
                        }
                  }
                  onRemove={() => {
                    onPatch({ frames: { ...draft.frames, [slot]: undefined } });
                  }}
                />
              );
            })}
          </View>
        </View>
      )}

      {form.refLimit > 0 && (
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.sm }}>
          <Text variant="caption" color="textMuted">
            {`References, up to ${form.refLimit}`}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
            {draft.refs.slice(0, form.refLimit).map((id, index) => (
              <MediaSlot
                key={id}
                label={`Reference ${index + 1}`}
                size={slotSize}
                uri={thumb(id)}
                filled
                onAdd={() => {
                  onAdd("ref");
                }}
                onPress={() => {
                  open(id);
                }}
                onRemove={() => {
                  onPatch({ refs: draft.refs.filter((ref) => ref !== id) });
                }}
              />
            ))}
            {draft.refs.length < form.refLimit && (
              <MediaSlot
                label={draft.refs.length === 0 ? "Reference" : `Reference ${draft.refs.length + 1}`}
                size={slotSize}
                uri={null}
                busy={uploading === "ref"}
                onAdd={() => {
                  onAdd("ref");
                }}
              />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

/** "12 credits, 488 left" from a quote and the backend's balance. */
export function quoteLine(quote: Quote | undefined, balance: number | undefined): string {
  if (quote === undefined) return balance === undefined ? "" : `${balance} credits left`;
  if (!quote.ok) return "No price yet";
  const left = quote.balance ?? balance;
  return left === undefined ? `${quote.credits} credits` : `${quote.credits} credits, ${left} left`;
}
