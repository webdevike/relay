import { Text as RNText, type TextProps as RNTextProps } from "react-native";
import { tabularNumbers, type, useColors, type ColorToken, type TypeToken } from "@/theme";

export interface TextProps extends RNTextProps {
  variant?: TypeToken;
  color?: ColorToken;
  tabular?: boolean;
}

export function Text({ variant = "body", color = "text", tabular = false, style, ...rest }: TextProps) {
  const colors = useColors();
  const scale = type[variant];
  return (
    <RNText
      style={[
        {
          fontSize: scale.fontSize,
          lineHeight: scale.lineHeight,
          fontWeight: scale.fontWeight,
          color: colors[color],
        },
        tabular && tabularNumbers,
        style,
      ]}
      {...rest}
    />
  );
}
