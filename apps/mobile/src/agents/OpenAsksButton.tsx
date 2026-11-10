import { StyleSheet, View } from "react-native";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { useColors } from "@/theme";

/**
 * The thread header's open-questions button: a question glyph with the number of questions still
 * waiting on Isaac in a small accent badge. The thread shows it only while that number is above 0.
 */
export function OpenAsksButton({ count, size, onPress }: { count: number; size: number; onPress: () => void }) {
  const colors = useColors();
  const shown = count > 99 ? "99+" : String(count);
  return (
    <View>
      <IconButton
        symbol="questionmark.bubble"
        size={size}
        glyphSize={19}
        backgroundColor="transparent"
        accessibilityLabel={count === 1 ? "1 open question" : `${String(count)} open questions`}
        onPress={onPress}
        testID="open-asks-button"
      />
      <View pointerEvents="none" style={[styles.badge, { backgroundColor: colors.accent }]}>
        <Text tabular style={styles.count}>
          {shown}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: "absolute", top: 2, right: 0, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, alignItems: "center", justifyContent: "center" },
  count: { fontSize: 11, lineHeight: 13, fontWeight: "600", color: "#FFFFFF" },
});
