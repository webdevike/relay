/**
 * The one composer pinned under a PR, ticket or Slack thread: a growing field and a send disc, an
 * optional "Replying to" chip over it and a muted hint under it. Sending only hands the text up;
 * the screen decides whether it is an Astra ask or a post that needs the confirm sheet.
 */
import { StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { spacing, useColors } from "@/theme";
import { BottomBar } from "@/ui/BottomBar";
import { Chip } from "@/ui/Chip";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";

export interface ComposerProps {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  placeholder: string;
  hint?: string | undefined;
  /** "Replying to Steve Arms": a tap on the chip goes back to a top-level comment. */
  replyingTo?: string | null | undefined;
  onClearReply?: (() => void) | undefined;
  busy?: boolean;
}

export function Composer({ value, onChange, onSend, placeholder, hint, replyingTo, onClearReply, busy = false }: ComposerProps) {
  const colors = useColors();
  return (
    <BottomBar>
      {replyingTo !== undefined && replyingTo !== null && (
        <View style={styles.reply}>
          <Chip
            label={`Replying to ${replyingTo}`}
            accessibilityLabel={`Replying to ${replyingTo}, tap to cancel`}
            leading={<SymbolView name="xmark" size={10} tintColor={colors.textMuted} />}
            onPress={() => {
              onClearReply?.();
            }}
          />
        </View>
      )}
      <View style={styles.row}>
        <View style={styles.field}>
          <TextField value={value} onChangeText={onChange} placeholder={placeholder} multiline accessibilityLabel="Comment" />
        </View>
        <IconButton symbol="arrow.up" size={36} accessibilityLabel="Send" disabled={busy || value.trim() === ""} onPress={onSend} />
      </View>
      {hint !== undefined && (
        <Text variant="caption" color="textFaint">
          {hint}
        </Text>
      )}
    </BottomBar>
  );
}

const styles = StyleSheet.create({
  reply: { flexDirection: "row" },
  row: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  field: { flex: 1 },
});
