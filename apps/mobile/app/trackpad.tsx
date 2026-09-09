import { View } from "react-native";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { IconButton } from "@/ui/IconButton";
import { spacing } from "@/theme";
import { actions } from "@/state/actions";

/**
 * Layout shell only. MobileTrackpad (wave 2) replaces the centered body with the live surface;
 * MobileDictation (wave 2) wires the mic button to `actions.insertText`.
 */
export default function TrackpadScreen() {
  return (
    <Screen title="Trackpad">
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text variant="body" color="textFaint">
          Trackpad
        </Text>
      </View>
      <View style={{ position: "absolute", right: spacing.xl, bottom: spacing.xl }}>
        <IconButton symbol="mic.fill" size={40} onPress={() => void actions.insertText("")} />
      </View>
    </Screen>
  );
}
