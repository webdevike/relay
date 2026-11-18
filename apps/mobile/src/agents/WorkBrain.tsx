import { Pressable, StyleSheet } from "react-native";
import { tapHaptic } from "@/lib/haptics";
import type { WorkBrain as Brain } from "@/lib/turnWork";
import { spacing, useColors } from "@/theme";
import { BrainIcon } from "@/ui/BrainIcon";
import { Pulse } from "@/ui/Pulse";

/** The glyph's size: quiet beside a reply, a 44pt target through its hit slop. */
const SIZE = 15;
const SLOP = 14;

/**
 * The small brain under an assistant's reply (and beside the typing dots while a turn has no reply yet) that
 * opens the work behind the turn (`TurnWorkSheet`). Faint like the reply's other marks; pulses softly while the
 * turn runs. Shown only with Settings' Show work on, on a host that answers `assistant.work.req`.
 */
export function WorkBrain({
  state,
  title,
  onOpen,
}: {
  state: Brain;
  title: string;
  onOpen: () => void;
}) {
  const colors = useColors();
  const live = state === "live";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={live ? `${title} is working: show the work` : `Show ${title}'s work`}
      hitSlop={SLOP}
      onPress={() => {
        tapHaptic();
        onOpen();
      }}
      style={({ pressed }) => [styles.brain, { opacity: pressed ? 0.5 : 1 }]}
      testID={live ? "work-brain-live" : "work-brain"}
    >
      <Pulse active={live}>
        <BrainIcon size={SIZE} color={live ? colors.textMuted : colors.textFaint} />
      </Pulse>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  brain: { alignSelf: "flex-start", marginTop: spacing.xs, paddingVertical: 2 },
});
