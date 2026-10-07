import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { tapHaptic } from "@/lib/haptics";
import { mediaClock } from "@/lib/format";
import { spacing, tabularNumbers, useColors } from "@/theme";
import { Text } from "@/ui/Text";

const BUTTON = 36;
const TRACK = 4;

export interface MediaTransportProps {
  playing: boolean;
  /** Seconds played so far. */
  currentTime: number;
  /** Clip length in seconds, or null while it is still loading (disables play and seek, shows --:--). */
  duration: number | null;
  onToggle: () => void;
  /** Seek to a 0..1 fraction of the clip. */
  onSeek: (fraction: number) => void;
  /** Extra control at the end of the row (e.g. a speed pill). */
  trailing?: ReactNode;
}

/** Shared media controls row: play/pause disc, a progress bar that seeks on tap, elapsed/total time. */
export function MediaTransport({ playing, currentTime, duration, onToggle, onSeek, trailing }: MediaTransportProps) {
  const length = duration !== null && duration > 0 ? duration : 0;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <PlayButton playing={playing} disabled={duration === null} onPress={onToggle} />
      <View style={{ flex: 1, gap: spacing.xs }}>
        <SeekBar progress={length > 0 ? Math.min(currentTime / length, 1) : 0} onSeek={length > 0 ? onSeek : undefined} />
        <Text variant="caption" color="textMuted" style={tabularNumbers}>
          {mediaClock(currentTime)} / {duration === null ? "--:--" : mediaClock(length)}
        </Text>
      </View>
      {trailing}
    </View>
  );
}

/** Solid round play/pause button. */
export function PlayButton({ playing, disabled, onPress }: { playing: boolean; disabled: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      hitSlop={8}
      disabled={disabled}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={playing ? "Pause" : "Play"}
      style={({ pressed }) => ({
        width: BUTTON,
        height: BUTTON,
        borderRadius: BUTTON / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.text,
        opacity: disabled ? 0.3 : pressed ? 0.7 : 1,
      })}
    >
      <SymbolView name={playing ? "pause.fill" : "play.fill"} size={16} tintColor={colors.bg} />
    </Pressable>
  );
}

/** Thin progress bar; tapping it seeks to that point. Without `onSeek` it only shows progress. */
export function SeekBar({ progress, onSeek }: { progress: number; onSeek?: ((fraction: number) => void) | undefined }) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  return (
    <Pressable
      hitSlop={{ top: 12, bottom: 12 }}
      disabled={onSeek === undefined}
      onLayout={(e) => {
        setWidth(e.nativeEvent.layout.width);
      }}
      onPress={(e) => {
        if (onSeek === undefined || width === 0) return;
        onSeek(Math.max(0, Math.min(e.nativeEvent.locationX / width, 1)));
      }}
      accessibilityLabel="Playback position"
      style={{ height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.hairline, overflow: "hidden" }}
    >
      <View style={{ width: `${progress * 100}%`, height: TRACK, backgroundColor: colors.accent }} />
    </Pressable>
  );
}
