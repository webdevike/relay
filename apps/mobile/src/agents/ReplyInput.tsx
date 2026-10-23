/**
 * The ```ui "input" widget: a text field and a submit button that sends the spec's `reply`
 * template, `{value}` filled with what was typed, as the session's next turn. Disabled where no
 * session is listening (see WidgetActions). In a ```openui fence an input with `bind` keeps its
 * text in the fence's runtime (shown from `value`, written with `setInput`), so other widgets can
 * read it, and stays editable even without a session.
 */
import { useState } from "react";
import { View } from "react-native";
import { spacing } from "@/theme";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { useOpenUIRuntime } from "./OpenUIRuntime";
import { useWidgetActions } from "./WidgetActions";
import type { InputSpec } from "./widget";

export function ReplyInput({ spec }: { spec: InputSpec }) {
  const actions = useWidgetActions();
  const runtime = useOpenUIRuntime();
  const [local, setLocal] = useState("");
  const [sent, setSent] = useState(false);
  const bound = spec.bind !== undefined && runtime !== null;
  const text = bound ? (spec.value ?? "") : local;
  const value = text.trim();
  const multiline = spec.multiline === true;

  const setText = (next: string) => {
    if (runtime !== null && spec.bind !== undefined) runtime.setInput(spec.bind, next);
    else setLocal(next);
  };

  const submit = () => {
    if (actions === null || value === "") return;
    // A function replacement, so `$&` and friends in the typed text stay literal.
    actions.reply(spec.reply.replace("{value}", () => value));
    setText("");
    setSent(true);
  };

  return (
    <View style={{ gap: spacing.xs }}>
      <View
        style={{
          flexDirection: multiline ? "column" : "row",
          alignItems: multiline ? "flex-end" : "center",
          gap: spacing.sm,
        }}
      >
        <View style={multiline ? { alignSelf: "stretch" } : { flex: 1 }}>
          <TextField
            value={text}
            onChangeText={(next) => {
              setText(next);
              setSent(false);
            }}
            placeholder={spec.placeholder}
            multiline={multiline}
            editable={actions !== null || bound}
            onSubmit={submit}
          />
        </View>
        <Button
          label={spec.button}
          onPress={submit}
          disabled={actions === null || value === ""}
        />
      </View>
      {sent && (
        <Text variant="caption" color="textMuted">
          Sent
        </Text>
      )}
    </View>
  );
}
