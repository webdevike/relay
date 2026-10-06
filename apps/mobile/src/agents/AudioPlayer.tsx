/**
 * Inline player for the ```ui "audio" widget: a play/pause button, a progress bar that seeks on
 * tap, elapsed/total time, and a speed pill that cycles 1x to 2x. The clip streams from the host
 * drop (or an https URL); nothing is fetched until the player mounts. Playback ignores the silent
 * switch, like a voice memo. The chosen speed is remembered for the next clip.
 */
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { SymbolView } from "expo-symbols";
import { tapHaptic } from "@/lib/haptics";
import { useSettingsStore } from "@/state/settings";
import { radii, spacing, tabularNumbers, useColors } from "@/theme";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { Text } from "@/ui/Text";
import { resolveDropSrc } from "./dropSrc";
import type { AudioSpec } from "./widget";

const BUTTON = 36;
const TRACK = 4;
/** Within this many seconds of the end counts as finished, so play restarts from zero. */
const END_SLACK = 0.1;
const RATES = [1, 1.25, 1.5, 1.75, 2];

export function AudioPlayer({ spec }: { spec: AudioSpec }) {
  const uri = resolveDropSrc(spec.src);
  return (
    <View style={{ gap: spacing.sm }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      {uri === null ? (
        <MediaPlaceholder label="Connect to the host to load this audio." />
      ) : (
        <Controls uri={uri} />
      )}
    </View>
  );
}

function Controls({ uri }: { uri: string }) {
  const colors = useColors();
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);
  const rate = useSettingsStore((state) => state.audioRate);
  const set = useSettingsStore((state) => state.set);
  const [trackWidth, setTrackWidth] = useState(0);
  const duration = status.duration > 0 ? status.duration : 0;
  const progress = duration > 0 ? Math.min(status.currentTime / duration, 1) : 0;

  // "high" pitch correction keeps voices natural when sped up.
  useEffect(() => {
    player.setPlaybackRate(rate, "high");
  }, [player, rate]);

  const toggle = async () => {
    tapHaptic();
    if (status.playing) {
      player.pause();
      return;
    }
    // Dictation leaves the session in playAndRecord + "measurement" mode, which plays quiet and
    // phone-call thin. expo-audio only resets the mode to default when the category options are
    // empty, and "doNotMix" is the one interruption mode that yields empty options.
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false, interruptionMode: "doNotMix" });
    if (duration > 0 && status.currentTime >= duration - END_SLACK) await player.seekTo(0);
    player.play();
  };

  const seek = (x: number) => {
    if (duration === 0 || trackWidth === 0) return;
    void player.seekTo(Math.max(0, Math.min(x / trackWidth, 1)) * duration);
  };

  const cycleRate = () => {
    tapHaptic();
    set({ audioRate: RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1 });
  };

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <PlayButton playing={status.playing} disabled={!status.isLoaded} onPress={() => void toggle()} />
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Pressable
          hitSlop={{ top: 12, bottom: 12 }}
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          onPress={(e) => seek(e.nativeEvent.locationX)}
          style={{ height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.hairline, overflow: "hidden" }}
        >
          <View style={{ width: `${progress * 100}%`, height: TRACK, backgroundColor: colors.accent }} />
        </Pressable>
        <Text variant="caption" color="textMuted" style={tabularNumbers}>
          {clock(status.currentTime)} / {status.isLoaded ? clock(duration) : "--:--"}
        </Text>
      </View>
      <Pressable
        hitSlop={8}
        onPress={cycleRate}
        accessibilityRole="button"
        accessibilityLabel={`Playback speed ${rate}x`}
        accessibilityHint="Cycles to the next speed"
        style={({ pressed }) => ({
          minWidth: 48,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          borderRadius: radii.sm,
          borderWidth: 1,
          borderColor: colors.hairline,
          alignItems: "center",
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text variant="label" color={rate === 1 ? "textMuted" : "accent"} style={tabularNumbers}>
          {rate}x
        </Text>
      </Pressable>
    </View>
  );
}

function PlayButton({ playing, disabled, onPress }: { playing: boolean; disabled: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      hitSlop={8}
      disabled={disabled}
      onPress={onPress}
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

/** Seconds to m:ss. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
