import { useRef } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { VideoView, type VideoPlayer } from "expo-video";
import { radii, spacing, useColors } from "@/theme";
import { IconButton } from "@/ui/IconButton";

export interface VideoFrameProps {
  player: VideoPlayer;
  width: number;
  height: number;
  playing: boolean;
  /** Still fetching: a spinner replaces the center play button. */
  loading: boolean;
  onToggle: () => void;
}

/**
 * Base video element: a rounded, sized frame around a native video surface (first frame shows as
 * the poster), a center play button while paused, a spinner while loading, and a corner button for
 * the system full-screen player. Tapping the picture toggles playback.
 */
export function VideoFrame({ player, width, height, playing, loading, onToggle }: VideoFrameProps) {
  const colors = useColors();
  const view = useRef<VideoView>(null);
  return (
    <View style={{ width, height, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surface }}>
      <VideoView
        ref={view}
        player={player}
        nativeControls={false}
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
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
        <IconButton
          symbol="arrow.up.left.and.arrow.down.right"
          tone="overlay"
          size={32}
          onPress={() => void view.current?.enterFullscreen()}
        />
      </View>
    </View>
  );
}
