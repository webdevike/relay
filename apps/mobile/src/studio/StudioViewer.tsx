/**
 * One Studio file full-screen on black: an image to pinch and pan, or a video with the native
 * controls, and a toolbar under it (Remix, Use as frame or Use last frame, Save, Share, Delete).
 * The toolbar sits below the media rather than over it, so it never covers the video's scrubber.
 */
import { useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVideoPlayer, VideoView } from "expo-video";
import type { StudioAsset } from "@relay/protocol";
import { spacing } from "@/theme";
import { ZoomableImage } from "@/agents/ZoomableImage";
import { IconButton } from "@/ui/IconButton";
import { Toast } from "@/ui/Toast";
import { ToolbarButton } from "@/ui/ToolbarButton";

export type ViewerAction = "remix" | "frame" | "save" | "share" | "delete";

export interface StudioViewerProps {
  /** The file on screen; null keeps the viewer closed. */
  asset: StudioAsset | null;
  /** Its full-size URL; null while disconnected. */
  uri: string | null;
  /** Remix needs the job that made it; uploads have none. */
  canRemix: boolean;
  /** The action still running, which shows a spinner. */
  busy: ViewerAction | null;
  message: string | null;
  onAction: (action: ViewerAction) => void;
  onClose: () => void;
}

export function StudioViewer({ asset, uri, canRemix, busy, message, onAction, onClose }: StudioViewerProps) {
  const insets = useSafeAreaInsets();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const video = asset?.kind === "video";

  return (
    <Modal visible={asset !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={["portrait", "landscape"]}>
      <GestureHandlerRootView style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom + spacing.sm }]}>
        <View style={styles.top}>
          <IconButton symbol="xmark" tone="overlay" size={44} accessibilityLabel="Close" onPress={onClose} />
        </View>
        <View
          style={styles.media}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setBox({ width, height });
          }}
        >
          {uri !== null && box.width > 0 && (video ? <ViewerVideo uri={uri} /> : <ZoomableImage uri={uri} width={box.width} height={box.height} onTap={onClose} />)}
          {message !== null && (
            <View style={styles.toast} pointerEvents="none">
              <Toast message={message} />
            </View>
          )}
        </View>
        <View style={styles.toolbar}>
          {canRemix && (
            <ToolbarButton
              symbol="wand.and.stars"
              label="Remix"
              tone="overlay"
              onPress={() => {
                onAction("remix");
              }}
            />
          )}
          <ToolbarButton
            symbol={video ? "film" : "rectangle.stack.badge.plus"}
            label={video ? "Use last frame" : "Use as frame"}
            tone="overlay"
            busy={busy === "frame"}
            onPress={() => {
              onAction("frame");
            }}
          />
          <ToolbarButton
            symbol="square.and.arrow.down"
            label="Save"
            tone="overlay"
            busy={busy === "save"}
            onPress={() => {
              onAction("save");
            }}
          />
          <ToolbarButton
            symbol="square.and.arrow.up"
            label="Share"
            tone="overlay"
            busy={busy === "share"}
            onPress={() => {
              onAction("share");
            }}
          />
          <ToolbarButton
            symbol="trash"
            label="Delete"
            tone="overlay"
            busy={busy === "delete"}
            onPress={() => {
              onAction("delete");
            }}
          />
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function ViewerVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.loop = true;
    p.play();
  });
  return <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls contentFit="contain" />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  top: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  media: { flex: 1 },
  toast: { position: "absolute", left: 0, right: 0, bottom: spacing.lg },
  toolbar: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: spacing.sm, paddingTop: spacing.md },
});
