/**
 * Inline player for the ```ui "video" widget: a frame at the video's aspect ratio (16:9 until the
 * track reports its size) showing the first frame as the poster, tap to play or pause, and the same
 * transport row as audio (play/pause, seekable progress bar, elapsed/total time). The corner button
 * opens the system full-screen player. Streams from the host drop (or an https URL) once mounted;
 * plays with the phone on silent, like audio.
 */
import { useState } from "react";
import { View } from "react-native";
import { useEvent } from "expo";
import { useVideoPlayer, type VideoPlayer as Player } from "expo-video";
import { spacing } from "@/theme";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { MediaTransport } from "@/ui/MediaTransport";
import { Text } from "@/ui/Text";
import { VideoFrame } from "@/ui/VideoFrame";
import { useDropSrc } from "./dropSrc";
import type { VideoSpec } from "./widget";

/** Frame shape until the video track reports its real size. */
const FALLBACK_ASPECT = 16 / 9;
/** Tall (portrait) videos stop growing at a square frame and narrow instead. */
const MAX_HEIGHT_RATIO = 1;
/** Within this many seconds of the end counts as finished, so play restarts from zero. */
const END_SLACK = 0.1;

export function VideoPlayer({ spec }: { spec: VideoSpec }) {
  const uri = useDropSrc(spec.src);
  const [width, setWidth] = useState(0);
  return (
    <View style={{ gap: spacing.sm }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
        }}
      >
        {uri === null ? (
          <MediaPlaceholder label="Connect to the host to load this video." width={width} height={width / FALLBACK_ASPECT} />
        ) : (
          width > 0 && <Playback uri={uri} width={width} />
        )}
      </View>
    </View>
  );
}

function Playback({ uri, width }: { uri: string; width: number }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.timeUpdateEventInterval = 0.25;
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: player.bufferedPosition,
  });
  const { videoTrack } = useEvent(player, "videoTrackChange", { videoTrack: player.videoTrack });

  const size = videoTrack?.size;
  const aspect = size !== undefined && size.width > 0 && size.height > 0 ? size.width / size.height : FALLBACK_ASPECT;
  const height = Math.min(width / aspect, width * MAX_HEIGHT_RATIO);
  const frameWidth = height * aspect;

  if (status === "error") {
    return <MediaPlaceholder label="Could not load this video." width={width} height={width / FALLBACK_ASPECT} />;
  }

  const ready = status === "readyToPlay" || (status === "loading" && isPlaying);
  const duration = player.duration > 0 ? player.duration : 0;
  const toggle = () => {
    togglePlayback(player, isPlaying, currentTime, duration);
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ alignItems: "center" }}>
        <VideoFrame
          player={player}
          width={frameWidth}
          height={height}
          playing={isPlaying}
          loading={status === "loading"}
          onToggle={toggle}
        />
      </View>
      <MediaTransport
        playing={isPlaying}
        currentTime={currentTime}
        duration={ready && duration > 0 ? duration : null}
        onToggle={toggle}
        onSeek={(fraction) => {
          player.currentTime = fraction * duration;
        }}
      />
    </View>
  );
}

function togglePlayback(player: Player, playing: boolean, currentTime: number, duration: number) {
  if (playing) {
    player.pause();
    return;
  }
  // expo-video switches the session to the playback category on play, so it ignores the silent switch.
  if (duration > 0 && currentTime >= duration - END_SLACK) player.currentTime = 0;
  player.play();
}
