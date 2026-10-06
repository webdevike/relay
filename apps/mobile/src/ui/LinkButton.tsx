import { Pressable } from "react-native";
import { SymbolView } from "expo-symbols";
import { useColors } from "@/theme";
import { Text } from "@/ui/Text";
import { IconButton } from "@/ui/IconButton";
import { openExternal } from "@/lib/links";

export interface LinkButtonProps {
  url: string;
  label?: string | undefined;
  variant?: "text" | "icon" | undefined;
  tone?: "default" | "overlay" | undefined;
}

/** Shared external-link affordance for widgets: inline text link, icon, or overlay icon button. */
export function LinkButton({ url, label, variant = "text", tone = "default" }: LinkButtonProps) {
  const colors = useColors();
  const open = () => {
    openExternal(url);
  };
  if (variant === "icon") {
    if (tone === "overlay") {
      return <IconButton symbol="safari" onPress={open} tone="overlay" />;
    }
    return (
      <Pressable
        hitSlop={10}
        onPress={open}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView name="arrow.up.right.square" size={18} tintColor={colors.accent} />
      </Pressable>
    );
  }
  return (
    <Pressable
      hitSlop={8}
      onPress={open}
      style={({ pressed }) => ({ alignSelf: "flex-start", opacity: pressed ? 0.6 : 1 })}
    >
      <Text variant="caption" color="accent">{`${label ?? "Open"} ↗`}</Text>
    </Pressable>
  );
}
