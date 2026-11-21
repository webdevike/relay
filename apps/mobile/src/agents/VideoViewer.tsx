import { Modal, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { VideoView, type VideoPlayer } from "expo-video";
import { openMediaActions } from "@/media/actions";
import { spacing } from "@/theme";
import { Holdable } from "@/ui/Holdable";
import { IconButton } from "@/ui/IconButton";
import { MediaNotice } from "@/ui/MediaNotice";

/**
 * Full screen the native controls own the picture, so the hold waits for iOS's usual long press:
 * a scrub that pauses on the thumb before it moves stays a scrub. There is no action wheel or bubble
 * here to beat, unlike inline.
 */
const VIEWER_HOLD_MS = 500;

/**
 * A video full screen on black, in our own modal rather than AVKit's full screen (whose view
 * controller nothing can be drawn over): the native player with its controls (play, scrub), and
 * over it a share button (Save to Photos, Share) and close. Holding the picture still opens the
 * same menu; a tap or a drag stays the player's. It shows `player` as it is, so an inline video
 * carries on where it was; `uri` is what the menu saves.
 *
 * The hold lives under its own GestureHandlerRootView: a React Native Modal renders in a detached
 * native hierarchy the app-root provider does not reach.
 */
export function VideoViewer({ player, uri, onClose }: { player: VideoPlayer; uri: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const share = () => {
    openMediaActions({ uri, kind: "video" });
  };
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]} statusBarTranslucent>
      <GestureHandlerRootView style={styles.backdrop}>
        <Holdable onHold={share} minDuration={VIEWER_HOLD_MS}>
          <View style={StyleSheet.absoluteFill} collapsable={false}>
            <VideoView
              player={player}
              style={StyleSheet.absoluteFill}
              nativeControls
              contentFit="contain"
              fullscreenOptions={{ enable: false }}
              allowsPictureInPicture={false}
              allowsVideoFrameAnalysis={false}
            />
          </View>
        </Holdable>
        <View style={[styles.top, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
          <IconButton symbol="square.and.arrow.up" tone="overlay" accessibilityLabel="Save or share" onPress={share} />
          <IconButton symbol="xmark" tone="overlay" accessibilityLabel="Close video" onPress={onClose} />
        </View>
        <MediaNotice viewer />
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#000" },
  top: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
});
