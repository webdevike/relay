import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { VideoView, type VideoPlayer } from "expo-video";
import { radii, spacing, useColors } from "@/theme";
import { Holdable } from "@/ui/Holdable";
import { IconButton } from "@/ui/IconButton";

export interface VideoFrameProps {
  player: VideoPlayer;
  width: number;
  height: number;
  playing: boolean;
  /** Still fetching: a spinner replaces the center play button. */
  loading: boolean;
  onToggle: () => void;
  /** The corner button: the caller shows the video full screen. */
  onExpand: () => void;
  /** Holding the video (`Holdable`): its save and share menu. */
  onLongPress?: (() => void) | undefined;
}

/**
 * Base video element: a rounded, sized frame around a native video surface (first frame shows as
 * the poster), a center play button while paused, a spinner while loading, and a corner button
 * that asks the caller for full screen (`onExpand`). Tapping the picture toggles playback; holding
 * it calls `onLongPress`. The frame draws its own controls, so the native ones stay off.
 */
export function VideoFrame({ player, width, height, playing, loading, onToggle, onExpand, onLongPress }: VideoFrameProps) {
  const colors = useColors();
  return (
    <Holdable onHold={onLongPress}>
      <View style={{ width, height, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surface }}>
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="contain"
          fullscreenOptions={{ enable: false }}
          allowsPictureInPicture={false}
          allowsVideoFrameAnalysis={false}
          style={{ width, height }}
        />
        <Pressable
          disabled={loading}
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={playing ? "Pause video" : "Play video"}
          style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : playing ? null : (
            <IconButton symbol="play.fill" tone="overlay" size={52} onPress={onToggle} />
          )}
        </Pressable>
        <View style={{ position: "absolute", top: spacing.xs, right: spacing.xs }}>
          <IconButton symbol="arrow.up.left.and.arrow.down.right" tone="overlay" size={32} accessibilityLabel="Full screen" onPress={onExpand} />
        </View>
      </View>
    </Holdable>
  );
}
