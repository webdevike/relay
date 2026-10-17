import { useState } from "react";
import { TextInput, type ReturnKeyTypeOptions } from "react-native";
import { radii, spacing, type, useColors, useScheme } from "@/theme";

/** Room a multiline field grows to before it scrolls: about five lines. */
const MAX_MULTILINE_HEIGHT = type.body.lineHeight * 5 + spacing.sm * 2;

export interface TextFieldProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string | undefined;
  multiline?: boolean | undefined;
  editable?: boolean;
  /** Return on a single-line field. */
  onSubmit?: () => void;
  accessibilityLabel?: string;
  /** A credential: no autocapitalize or autocorrect, and the keyboard offers saved logins of that kind. A password is masked. */
  credential?: "username" | "password";
  /** Overrides the key's label (default: send, or return when multiline). */
  returnKeyType?: ReturnKeyTypeOptions;
}

/** A bordered text field on the page background; the hairline darkens a step while focused. */
export function TextField({
  value,
  onChangeText,
  placeholder,
  multiline = false,
  editable = true,
  onSubmit,
  accessibilityLabel,
  credential,
  returnKeyType,
}: TextFieldProps) {
  const colors = useColors();
  const scheme = useScheme();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textFaint}
      multiline={multiline}
      editable={editable}
      onSubmitEditing={multiline ? undefined : onSubmit}
      returnKeyType={returnKeyType ?? (multiline ? "default" : "send")}
      secureTextEntry={credential === "password"}
      autoCapitalize={credential === undefined ? undefined : "none"}
      autoCorrect={credential === undefined ? undefined : false}
      textContentType={credential}
      autoComplete={credential}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
      }}
      keyboardAppearance={scheme}
      selectionColor={colors.accent}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      style={{
        minHeight: 36,
        maxHeight: multiline ? MAX_MULTILINE_HEIGHT : undefined,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: focused ? colors.textFaint : colors.hairline,
        backgroundColor: colors.bg,
        color: colors.text,
        fontSize: type.body.fontSize,
        opacity: editable ? 1 : 0.5,
      }}
    />
  );
}
