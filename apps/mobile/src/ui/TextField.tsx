import { useState, type ReactNode } from "react";
import { TextInput, View, type KeyboardTypeOptions, type ReturnKeyTypeOptions } from "react-native";
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
  /** e.g. `number-pad` for a seed. */
  keyboardType?: KeyboardTypeOptions;
  maxLength?: number;
  /** Overrides the default 36 pt minimum height (44 pt where it must be a touch target). */
  minHeight?: number;
  /** A control inside the field's right end (a send button); the border then wraps both. */
  trailing?: ReactNode;
  /** Fill instead of the page background, for a field on a card (a card stack card). */
  fill?: string;
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
  keyboardType,
  maxLength,
  minHeight = 36,
  trailing,
  fill,
}: TextFieldProps) {
  const colors = useColors();
  const scheme = useScheme();
  const [focused, setFocused] = useState(false);
  const frame = {
    minHeight,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: focused ? colors.textFaint : colors.hairline,
    backgroundColor: fill ?? colors.bg,
    opacity: editable ? 1 : 0.5,
  };
  const input = (
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
      keyboardType={keyboardType}
      autoComplete={credential}
      maxLength={maxLength}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
      }}
      keyboardAppearance={scheme}
      selectionColor={colors.accent}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      style={[
        {
          maxHeight: multiline ? MAX_MULTILINE_HEIGHT : undefined,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          color: colors.text,
          fontSize: type.body.fontSize,
        },
        trailing === undefined ? frame : { flex: 1, minHeight: minHeight - 2 },
      ]}
    />
  );
  if (trailing === undefined) return input;
  return (
    <View style={[frame, { flexDirection: "row", alignItems: "center", paddingRight: spacing.xs }]}>
      {input}
      {trailing}
    </View>
  );
}
