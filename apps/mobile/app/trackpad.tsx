import { useCallback, useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useKeepAwake } from "expo-keep-awake";
import { requireOptionalNativeModule } from "expo-modules-core";
import type * as ScreenOrientationModule from "expo-screen-orientation";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconButton } from "@/ui/IconButton";
import { Cutout, CUTOUT_GAP } from "@/ui/Cutout";
import { colors } from "@/theme";
import { SURFACE_MARGIN, TrackpadSurface } from "@/trackpad/TrackpadSurface";
import { DictationButton } from "@/dictation/DictationButton";
import { ListeningOrb } from "@/dictation/ListeningOrb";
import type { ActionWheelEntry } from "@/agents/ActionWheel";
import { hostBaseUrl, sendCommand } from "@/connection";
import { useDropsStore } from "@/state/drops";
import { copyImage, copyText, readClipboardImage, readClipboardText } from "@/lib/clipboard";
import { notifyHaptic, tapHaptic } from "@/lib/haptics";
import { downloadDrop, hasFile } from "@/drops/actions";
import { warn } from "@/connection/log";

export interface TrackpadScreenProps {
  /**
   * Lazily swappable dictation slot. Defaults to the real `DictationButton`; a caller (or a
   * future test) can override it, and if `@/dictation/DictationButton` had not landed yet this
   * default would fall back to the foundation's `IconButton` placeholder instead.
   */
  renderDictationButton?: () => ReactNode;
}

const BACK_SIZE = 40;
const MIC_SIZE = 60;
/** Back sits on the top edge, in from the corner, so it never crowds the screen edge. */
const BACK_INSET = 12;

const defaultDictationButton = (): ReactNode => (
  <DictationButton size={MIC_SIZE} backgroundColor={colors.surface} />
);

/**
 * Copy: the newest thing copied on the host (the clipboard watcher files every desktop copy as a
 * host drop) lands on the phone's clipboard. Paste: the phone's clipboard goes into the focused
 * app on the host, an image through the host clipboard, text typed as keystrokes.
 */
const wheelEntries: ActionWheelEntry[] = [
  { key: "copy", label: "Copy", symbol: "doc.on.doc" },
  { key: "paste", label: "Paste", symbol: "doc.on.clipboard" },
];

async function copyFromHost(): Promise<void> {
  const drop = useDropsStore.getState().drops.find((candidate) => candidate.origin === "host");
  if (drop === undefined) return;
  if (drop.text !== undefined) {
    await copyText(drop.text);
  } else {
    const base = hostBaseUrl();
    if (base === null || drop.kind !== "image" || !hasFile(drop)) return;
    const file = await downloadDrop(base, drop);
    await copyImage(await file.base64());
  }
  notifyHaptic("success");
}

async function pasteToHost(): Promise<void> {
  const image = await readClipboardImage();
  if (image !== null) {
    await sendCommand({
      kind: "clipboard.paste",
      image: { mimeType: image.mimeType, data: image.data },
    });
    notifyHaptic("success");
    return;
  }
  const text = await readClipboardText();
  if (text === null) return;
  await sendCommand({ kind: "text.insert", text });
  notifyHaptic("success");
}

/** Edge-to-edge trackpad: full-bleed gesture surface, ghost back chevron, floating dictation. */
export default function TrackpadScreen({
  renderDictationButton = defaultDictationButton,
}: TrackpadScreenProps) {
  useKeepAwake();
  const router = useRouter();

  useEffect(() => {
    // Follow the phone (any orientation) while the trackpad is up; the rest of the app is portrait.
    // Guarded so a dev client built before expo-screen-orientation was added still loads.
    if (requireOptionalNativeModule("ExpoScreenOrientation") === null) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred so the import above stays optional
    const ScreenOrientation = require("expo-screen-orientation") as typeof ScreenOrientationModule;
    void ScreenOrientation.unlockAsync();
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  const onWheel = useCallback((key: string) => {
    tapHaptic();
    (key === "copy" ? copyFromHost() : pasteToHost()).catch((error: unknown) => {
      notifyHaptic("error");
      warn("trackpad", `${key} failed`, error);
    });
  }, []);

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.bg }}
      edges={["top", "bottom", "left", "right"]}
    >
      <StatusBar hidden />
      <View style={{ flex: 1 }}>
        <TrackpadSurface wheel={wheelEntries} onWheel={onWheel} />
        <ListeningOrb />
        <Cutout
          size={BACK_SIZE}
          style={{
            top: SURFACE_MARGIN - (BACK_SIZE + CUTOUT_GAP * 2) / 2,
            left: SURFACE_MARGIN + BACK_INSET,
          }}
        >
          <IconButton
            symbol="chevron.left"
            size={BACK_SIZE}
            tintColor={colors.textMuted}
            backgroundColor={colors.surface}
            onPress={() => {
              router.back();
            }}
          />
        </Cutout>
        <Cutout
          size={MIC_SIZE}
          style={{ bottom: SURFACE_MARGIN - (MIC_SIZE + CUTOUT_GAP * 2) / 2, alignSelf: "center" }}
        >
          {renderDictationButton()}
        </Cutout>
      </View>
    </SafeAreaView>
  );
}
