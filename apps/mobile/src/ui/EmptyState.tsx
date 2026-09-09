import { View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "./Text";
import { Button } from "./Button";
import { colors, spacing } from "@/theme";

export interface EmptyStateProps {
  symbol: SFSymbol;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ symbol, title, body, actionLabel, onAction }: EmptyStateProps) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxxl, gap: spacing.md }}>
      <SymbolView name={symbol} size={32} tintColor={colors.textFaint} />
      <Text variant="title" style={{ textAlign: "center" }}>
        {title}
      </Text>
      <Text variant="body" color="textMuted" style={{ textAlign: "center" }}>
        {body}
      </Text>
      {actionLabel !== undefined && onAction !== undefined && (
        <View style={{ marginTop: spacing.sm }}>
          <Button label={actionLabel} onPress={onAction} variant="secondary" />
        </View>
      )}
    </View>
  );
}
