/**
 * Fallback for an install without the native `modules/paste-image` (an older TestFlight build running
 * this bundle over OTA): iOS text fields drop a pasted image there, so a composer offers it instead.
 * While the field is focused and the clipboard holds an image, a "Paste image" chip sits above it; a
 * tap reads the image (`onImage`). Checking for an image does not read it, so no paste prompt shows
 * until the tap. Renders nothing when the native module is present: long-press Paste does it there.
 */
import { useEffect, useState } from "react";
import {
  AppState,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { SymbolView } from "expo-symbols";
import { clipboardHasImage, readClipboardImage } from "@/lib/clipboard";
import { warn } from "@/connection/log";
import { hasNativePasteImage } from "@/lib/pasteImage";
import type { PendingImage } from "@/dictation/machine";
import { tapHaptic } from "@/lib/haptics";
import { spacing, useColors } from "@/theme";
import { Text } from "./Text";

export function PasteImageChip({
  active,
  onImage,
  style,
}: {
  active: boolean;
  onImage: (image: PendingImage) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!active || hasNativePasteImage) {
      setHas(false);
      return;
    }
    let live = true;
    const check = (): void => {
      clipboardHasImage().then(
        (next) => {
          if (live) setHas(next);
        },
        () => {
          if (live) setHas(false);
        },
      );
    };
    check();
    const copied = Clipboard.addClipboardListener(check);
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      live = false;
      Clipboard.removeClipboardListener(copied);
      foreground.remove();
    };
  }, [active]);
  if (!has || hasNativePasteImage) return null;
  return (
    <View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Paste image from clipboard"
        onPress={() => {
          tapHaptic();
          setHas(false);
          readClipboardImage().then(
            (image) => {
              if (image !== null) onImage(image);
            },
            (error: unknown) => {
              warn("agents", "paste image failed", error);
            },
          );
        }}
        style={({ pressed }) => [
          styles.chip,
          { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline },
          pressed && { opacity: 0.6 },
        ]}
      >
        <SymbolView name="doc.on.clipboard" size={13} tintColor={colors.accent} weight="medium" />
        <Text variant="caption" color="text">
          Paste image
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
