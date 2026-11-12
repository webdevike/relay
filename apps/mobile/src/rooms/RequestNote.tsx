/** Under a card or control: the refusal of its last action, or Not confirmed with Try again (same rid). */
import { View } from "react-native";
import { spacing } from "@/theme";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { TAP } from "./primitives";
import type { RoomsAction } from "./useRoomsAction";

export const NOT_CONFIRMED = "Not confirmed. Your Mac may have done it.";

export function RequestNote({ action }: { action: RoomsAction }) {
  if (action.unconfirmed !== null) {
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm }}>
        <Text variant="label" color="warn">{NOT_CONFIRMED}</Text>
        <Button label="Try again" variant="ghost" height={TAP} onPress={action.retry} />
      </View>
    );
  }
  if (action.error !== null) return <Text variant="label" color="danger">{action.error}</Text>;
  return null;
}
