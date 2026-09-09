import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { TextInput, View } from "react-native";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { colors, radii, spacing } from "@/theme";
import { useConnectionStore } from "@/state/connection";
import { actions } from "@/state/actions";

const PIN_LENGTH = 6;

const failureMessage: Record<string, string> = {
  wrong_pin: "That PIN didn't match. Try again.",
  rejected: "Pairing was declined on your Mac.",
  timeout: "Pairing timed out. Try again.",
  too_many_attempts: "Too many attempts. Wait a moment and try again.",
};

export default function Pairing() {
  const [pin, setPin] = useState("");
  const failure = useConnectionStore((state) => state.pairing.failure);
  const pinRequired = useConnectionStore((state) => state.pairing.pinRequired);
  const status = useConnectionStore((state) => state.status);
  const router = useRouter();

  useEffect(() => {
    if (status === "connected") router.dismissAll();
  }, [status, router]);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (failure !== null) setPin("");
  }, [failure]);

  const onChange = (next: string) => {
    const digits = next.replace(/\D/g, "").slice(0, PIN_LENGTH);
    setPin(digits);
    if (digits.length === PIN_LENGTH) actions.submitPin(digits);
  };

  return (
    <Screen title="Pair with your Mac">
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.xxl }}>
        <Text variant="body" color="textMuted" style={{ textAlign: "center", paddingHorizontal: spacing.xxxl }}>
          {pinRequired ? "Enter the 6-digit code shown on your Mac." : "Waiting for your Mac to show a code…"}
        </Text>
        <TextInput
          ref={inputRef}
          value={pin}
          onChangeText={onChange}
          keyboardType="number-pad"
          maxLength={PIN_LENGTH}
          autoFocus
          style={{
            width: 220,
            textAlign: "center",
            fontSize: 32,
            fontVariant: ["tabular-nums"],
            letterSpacing: 12,
            color: colors.text,
            backgroundColor: colors.surface,
            borderRadius: radii.md,
            paddingVertical: spacing.lg,
          }}
        />
        {failure !== null && (
          <Banner
            tone="danger"
            message={failureMessage[failure] ?? "Pairing failed."}
            {...(failure === "wrong_pin"
              ? {}
              : {
                  actionLabel: "Try again",
                  onAction: () => {
                    setPin("");
                    actions.startPairing();
                  },
                })}
          />
        )}
      </View>
    </Screen>
  );
}
