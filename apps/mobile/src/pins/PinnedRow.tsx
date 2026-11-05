/**
 * The thread's Pinned row, under its header: one chip per pin (newest first), horizontal. A tap
 * copies the pin's value (the chip says "Copied" for a moment); a long press offers Unpin. Nothing
 * shows while the thread has no pins. The pins are the thread's pinned artifacts; the host owns them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, Pressable, ScrollView } from "react-native";
import * as Clipboard from "expo-clipboard";
import { SymbolView } from "expo-symbols";
import { pinsOf, type Pin } from "@relay/protocol";
import { actArtifacts } from "@/connection";
import { useArtifactsStore } from "@/state/artifacts";
import { notifyHaptic, tapHaptic } from "@/lib/haptics";
import { radii, spacing, toneFill, useColors } from "@/theme";
import { Text } from "@/ui/Text";
import { COPIED_MS, pinChipText } from "./chips";

/** Height the row takes under the header: the chip and a little air. */
export const PINNED_ROW_HEIGHT = 36;
const CHIP_HEIGHT = 28;

/** How many pins `thread` holds, so a screen can make room for the row. */
export function usePinCount(thread: string): number {
  return useArtifactsStore((state) => {
    const items = state.threads[thread]?.items;
    return items === undefined ? 0 : items.filter((item) => item.pinned !== undefined).length;
  });
}

export function PinnedRow({ thread }: { thread: string }) {
  const items = useArtifactsStore((state) => state.threads[thread]?.items);
  const pins = useMemo(() => (items === undefined ? [] : pinsOf(items)), [items]);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (pins.length === 0) return null;

  const copy = (pin: Pin): void => {
    tapHaptic();
    Clipboard.setStringAsync(pin.value).then(
      () => {
        notifyHaptic("success");
        setCopied(pin.id);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setCopied(null);
        }, COPIED_MS);
      },
      () => undefined,
    );
  };
  const offerUnpin = (pin: Pin): void => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: pin.label, options: ["Unpin", "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (index) => {
        if (index === 0) void actArtifacts(thread, { op: "pin.remove", id: pin.id });
      },
    );
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ flexGrow: 0, height: PINNED_ROW_HEIGHT }}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.xs, alignItems: "center" }}
      accessibilityLabel="Pinned"
      testID="pinned-row"
    >
      {pins.map((pin) => (
        <PinChip key={pin.id} pin={pin} copied={copied === pin.id} onCopy={copy} onUnpin={offerUnpin} />
      ))}
    </ScrollView>
  );
}

function PinChip({ pin, copied, onCopy, onUnpin }: { pin: Pin; copied: boolean; onCopy: (pin: Pin) => void; onUnpin: (pin: Pin) => void }) {
  const colors = useColors();
  const { label, value, mono } = pinChipText(pin);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pin.label}, pinned. Tap to copy, hold to unpin`}
      accessibilityHint="Copies the value"
      testID={`pin-chip-${pin.id}`}
      onPress={() => {
        onCopy(pin);
      }}
      onLongPress={() => {
        onUnpin(pin);
      }}
      delayLongPress={350}
      style={({ pressed }) => ({
        height: CHIP_HEIGHT,
        maxWidth: 260,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs,
        paddingHorizontal: spacing.md,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: copied ? colors.accent : colors.hairline,
        backgroundColor: copied ? toneFill(colors, "accent", 0.12) : colors.surfaceRaised,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <SymbolView name={copied ? "checkmark" : "pin"} size={11} tintColor={copied ? colors.accent : colors.textMuted} />
      <Text variant="caption" color={copied ? "accent" : "textMuted"} numberOfLines={1} style={{ flexShrink: 1 }}>
        {copied ? "Copied" : label}
      </Text>
      {!copied && value !== null ? (
        <Text variant="caption" numberOfLines={1} style={[{ flexShrink: 1 }, mono ? { fontFamily: "Menlo" } : null]}>
          {value}
        </Text>
      ) : null}
    </Pressable>
  );
}
