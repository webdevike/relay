/**
 * The effort dial's stepped slider: one stop per notch, a large knob, swipe to slide and tap
 * anywhere on the track or a label to jump to that stop. Built on PanResponder (no native module)
 * and sized for a thumb: the whole 80pt-tall block takes the touch, the knob is 40pt. VoiceOver
 * steps it as an adjustable control.
 */
import { useRef, useState } from "react";
import { PanResponder, View, type LayoutChangeEvent } from "react-native";
import { COUNCIL_NOTCHES } from "@relay/protocol";
import { selectHaptic } from "@/lib/haptics";
import { useColors } from "@/theme";
import { Text } from "@/ui/Text";
import { stopAt } from "./model";

const KNOB = 40;
const INSET = KNOB / 2;
const TRACK = 6;
const DOT = 12;
const LABEL_W = 58;
const TRACK_TOP = 8;
const HEIGHT = 84;


export interface EffortSliderProps {
  value: number;
  onChange: (effort: number) => void;
  disabled?: boolean;
}

export function EffortSlider({ value, onChange, disabled = false }: EffortSliderProps) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const stops = COUNCIL_NOTCHES.length;
  // The responder is made once; it reads what changed through this.
  const live = useRef({ width, value, onChange, disabled });
  live.current = { width, value, onChange, disabled };
  const origin = useRef(0);
  const move = (x: number): void => {
    const { width: w, value: current, onChange: change, disabled: off } = live.current;
    if (off) return;
    const next = stopAt(x, w, stops, INSET);
    if (next === current) return;
    selectHaptic();
    change(next);
  };
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.disabled,
      onMoveShouldSetPanResponder: () => !live.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        origin.current = event.nativeEvent.locationX;
        move(origin.current);
      },
      onPanResponderMove: (_event, gesture) => {
        move(origin.current + gesture.dx);
      },
    }),
  ).current;

  const span = Math.max(0, width - INSET * 2);
  const xOf = (stop: number): number => INSET + (span * (stop - 1)) / (stops - 1);
  const notch = COUNCIL_NOTCHES[value - 1];
  return (
    <View
      {...responder.panHandlers}
      onLayout={(event: LayoutChangeEvent) => {
        setWidth(event.nativeEvent.layout.width);
      }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Effort"
      accessibilityValue={{ min: 1, max: stops, now: value, text: notch?.name ?? "" }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => {
        if (disabled) return;
        const next = event.nativeEvent.actionName === "increment" ? Math.min(stops, value + 1) : Math.max(1, value - 1);
        if (next !== value) onChange(next);
      }}
      style={{ height: HEIGHT, opacity: disabled ? 0.6 : 1 }}
    >
      {width > 0 && (
        <>
          <View pointerEvents="none" style={{ position: "absolute", left: INSET, right: INSET, top: TRACK_TOP + KNOB / 2 - TRACK / 2, height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.surfaceRaised }} />
          <View pointerEvents="none" style={{ position: "absolute", left: INSET, width: xOf(value) - INSET, top: TRACK_TOP + KNOB / 2 - TRACK / 2, height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.accent }} />
          {COUNCIL_NOTCHES.map((n) => (
            <View key={n.effort} pointerEvents="none" style={{ position: "absolute", left: xOf(n.effort) - DOT / 2, top: TRACK_TOP + KNOB / 2 - DOT / 2, width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: n.effort <= value ? colors.accent : colors.hairline, borderWidth: 2, borderColor: colors.surface }} />
          ))}
          <View pointerEvents="none" style={{ position: "absolute", left: xOf(value) - KNOB / 2, top: TRACK_TOP, width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: "#FFFFFF", borderWidth: 3, borderColor: colors.accent }} />
          {COUNCIL_NOTCHES.map((n) => (
            <View key={`l${String(n.effort)}`} pointerEvents="none" style={{ position: "absolute", left: xOf(n.effort) - LABEL_W / 2, width: LABEL_W, top: TRACK_TOP + KNOB + 12, alignItems: "center" }}>
              <Text variant="label" color={n.effort === value ? "text" : "textMuted"} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.92} style={n.effort === value ? { fontWeight: "700" } : undefined}>
                {n.name}
              </Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}
