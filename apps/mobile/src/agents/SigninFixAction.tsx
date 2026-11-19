import { View } from "react-native";
import type { SigninFix } from "@relay/protocol";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { copyText } from "@/lib/clipboard";
import { signinCommand, signinGuidance } from "@/lib/signin";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { spacing } from "@/theme";

/**
 * Under a failed turn's error row whose cause is a broken sign-in: where to sign in again on the
 * Mac, and the command to copy. The phone cannot start the Mac's OAuth login (no phone-to-desktop
 * open request exists in the protocol), so this is guidance, not a button that signs in.
 */
export function SigninFixAction({ fix }: { fix: SigninFix }) {
  const copied = useTransientMessage();
  return (
    <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
      <Text variant="label" color="textMuted">
        {signinGuidance(fix)}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <Button
          label={copied.message ?? "Copy sign-in command"}
          variant="secondary"
          symbol={copied.message === null ? "doc.on.doc" : "checkmark"}
          accessibilityLabel="Copy the sign-in command"
          onPress={() => {
            copyText(signinCommand(fix)).then(
              () => {
                copied.show("Copied");
              },
              () => {
                copied.show("Couldn't copy");
              },
            );
          }}
        />
      </View>
    </View>
  );
}
