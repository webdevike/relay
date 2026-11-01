/** Snooze's choices for an item: later today, tomorrow morning, next Monday morning (`snoozeChoices`). */
import { StyleSheet } from "react-native";
import { clockTime } from "@/lib/format";
import { spacing } from "@/theme";
import { Row } from "@/ui/Row";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { snoozeChoices } from "./model";

export interface SnoozeSheetProps {
  visible: boolean;
  onClose: () => void;
  onPick: (until: number) => void;
}

export function SnoozeSheet({ visible, onClose, onPick }: SnoozeSheetProps) {
  const now = Date.now();
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text variant="title" style={styles.title}>
        Snooze until
      </Text>
      {snoozeChoices(now).map((choice) => (
        <Row
          key={choice.key}
          title={choice.label}
          subtitle={`${new Date(choice.until).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}, ${clockTime(choice.until)}`}
          testID={`snooze-${choice.key}`}
          onPress={() => {
            onPick(choice.until);
          }}
        />
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { paddingVertical: spacing.sm },
});
