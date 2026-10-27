/**
 * A video embedded in a message as `![caption](src)` (see `videoEmbed.ts`), shown like a chat
 * app's video bubble: a frame at the video's aspect (from the drop, 16:9 until known), up to
 * `MAX_WIDTH` or `WIDTH_FRACTION` of the screen and `MAX_HEIGHT` tall, showing the host's poster
 * with a play button and the length. Nothing streams until it is tapped; then the native player
 * takes the frame (its own controls: play/pause, ±10 s, scrubbing) and plays with sound. At bubble
 * size AVKit leaves full screen out of those controls, so a corner button opens it (the full-screen
 * player has its own controls and Done). The poster stays on top until the first frame draws, so
 * the tap never flashes black.
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { mediaClock } from "@/lib/format";
import { spacing } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { OverlayTag } from "@/ui/OverlayTag";
import { useDropSrc } from "./dropSrc";
import type { VideoEmbed } from "./videoEmbed";

const MAX_WIDTH = 320;
const WIDTH_FRACTION = 0.72;
const MAX_HEIGHT = 380;
const FALLBACK_ASPECT = 16 / 9;
/** Matches `MarkdownImages` tiles. */
const RADIUS = 22;

export function InlineVideo({ video, alt }: { video: VideoEmbed; alt: string }) {
  const screen = useWindowDimensions().width;
  const [uri, poster] = useDropSrc([video.src, video.poster ?? ""]);
  const [phase, setPhase] = useState<"poster" | "starting" | "playing" | "error">("poster");
  const [trackAspect, setTrackAspect] = useState<number | null>(null);

  const aspect = video.aspect ?? trackAspect ?? FALLBACK_ASPECT;
  const widest = Math.min(MAX_WIDTH, Math.round(screen * WIDTH_FRACTION));
  const height = Math.round(Math.min(widest / aspect, MAX_HEIGHT));
  const width = Math.round(height * aspect);

  if (uri === null || uri === undefined) return <MediaPlaceholder label="Connect to the host to load this video." />;
  if (phase === "error") {
    const label =
      video.mimeType === "video/webm"
        ? "iPhone can't play WebM. Share an mp4 (H.264) instead."
        : alt === ""
          ? "Could not play this video."
          : `Could not play this video: ${alt}`;
    return <MediaPlaceholder label={label} width={width} height={height} />;
  }
  const start = () => {
    setPhase("starting");
  };
  const label = alt === "" ? "Play video" : `Play video: ${alt}`;
  return (
    <View style={{ width, height, borderRadius: RADIUS, overflow: "hidden", backgroundColor: "#000000" }}>
      {phase !== "poster" && (
        <Playback
          uri={uri}
          width={width}
          height={height}
          onAspect={setTrackAspect}
          onFirstFrame={() => {
            setPhase("playing");
          }}
          onError={() => {
            setPhase("error");
          }}
        />
      )}
      {phase !== "playing" && (
        <Pressable
          onPress={start}
          disabled={phase === "starting"}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={[StyleSheet.absoluteFill, styles.center]}
        >
          {poster !== null && poster !== undefined && poster !== "" && (
            <Image source={{ uri: poster }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
          )}
          {phase === "starting" ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <IconButton symbol="play.fill" tone="overlay" size={52} onPress={start} accessibilityLabel={label} />
          )}
          {phase === "poster" && video.durationMs !== undefined && (
            <OverlayTag corner="bottom-right" icon="video.fill" label={mediaClock(video.durationMs / 1000)} />
          )}
        </Pressable>
      )}
    </View>
  );
}

interface PlaybackProps {
  uri: string;
  width: number;
  height: number;
  onAspect: (aspect: number) => void;
  onFirstFrame: () => void;
  onError: () => void;
}

/** Mounted by the tap: loads the stream, plays at once (unmuted), native controls inline and full screen. */
function Playback({ uri, width, height, onAspect, onFirstFrame, onError }: PlaybackProps) {
  const view = useRef<VideoView>(null);
  const player = useVideoPlayer({ uri }, (p) => {
    // expo-video switches the audio session to playback on play, so it plays through the silent switch.
    p.play();
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const { videoTrack } = useEvent(player, "videoTrackChange", { videoTrack: player.videoTrack });

  const size = videoTrack?.size;
  useEffect(() => {
    if (size !== undefined && size.width > 0 && size.height > 0) onAspect(size.width / size.height);
  }, [size, onAspect]);
  useEffect(() => {
    if (status === "error") onError();
  }, [status, onError]);

  return (
    <View style={{ width, height }}>
      <VideoView
        ref={view}
        player={player}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture={false}
        allowsVideoFrameAnalysis={false}
        onFirstFrameRender={onFirstFrame}
        style={{ width, height }}
      />
      <View style={styles.corner}>
        <IconButton
          symbol="arrow.up.left.and.arrow.down.right"
          tone="overlay"
          size={32}
          accessibilityLabel="Full screen"
          onPress={() => {
            void view.current?.enterFullscreen();
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  corner: { position: "absolute", top: spacing.sm, right: spacing.sm },
});
