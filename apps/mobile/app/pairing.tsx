import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, TextInput, View } from "react-native";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { radii, spacing, useColors } from "@/theme";
import { useConnectionStore } from "@/state/connection";
import { actions } from "@/state/actions";
import { PAIRING_DEADLINE_MS, pairingView } from "@/connection/pairingView";

const PIN_LENGTH = 6;

export default function Pairing() {
  const colors = useColors();
  const [pin, setPin] = useState("");
  const pairing = useConnectionStore((state) => state.pairing);
  const status = useConnectionStore((state) => state.status);
  const lastError = useConnectionStore((state) => state.lastError);
  const macName = useConnectionStore((state) => state.macName);
  const activeHostId = useConnectionStore((state) => state.activeHostId);
  const router = useRouter();
  // Each attempt gets PAIRING_DEADLINE_MS to reach the host and show a code before the screen says why not.
  const [attempt, setAttempt] = useState(0);
  const [expired, setExpired] = useState(false);
  const view = pairingView({ status, pairing, lastError, hostName: macName ?? activeHostId, expired });

  useEffect(() => {
    if (status === "connected") router.dismissAll();
  }, [status, router]);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    setExpired(false);
    const timer = setTimeout(() => {
      setExpired(true);
    }, PAIRING_DEADLINE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [attempt]);

  useEffect(() => {
    if (pairing.pinRequired) inputRef.current?.focus();
  }, [pairing.pinRequired]);

  useEffect(() => {
    if (pairing.failure !== null) setPin("");
  }, [pairing.failure]);

  const onChange = (next: string) => {
    const digits = next.replace(/\D/g, "").slice(0, PIN_LENGTH);
    setPin(digits);
    if (digits.length === PIN_LENGTH) actions.submitPin(digits);
  };

  const retry = () => {
    setPin("");
    setAttempt((n) => n + 1);
    // A dead or silent connection starts over against the same host; a host-reported failure asks it again.
    if (view.restart && activeHostId !== null) actions.switchHost(activeHostId);
    else actions.startPairing();
  };

  return (
    <Screen title="Pair with your Mac">
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.xxl }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xxxl }}>
          {view.busy && <ActivityIndicator size="small" color={colors.textMuted} />}
          <Text variant="body" color="textMuted" style={{ textAlign: "center", flexShrink: 1 }}>
            {view.message}
          </Text>
        </View>
        <TextInput
          ref={inputRef}
          value={pin}
          onChangeText={onChange}
          editable={pairing.pinRequired}
          keyboardType="number-pad"
          maxLength={PIN_LENGTH}
          accessibilityLabel="Pairing code"
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
            opacity: pairing.pinRequired ? 1 : 0.4,
          }}
        />
        {view.error !== null && (
          <Banner
            tone="danger"
            message={view.error}
            {...(pairing.failure === "wrong_pin" ? {} : { actionLabel: "Try again", onAction: retry })}
          />
        )}
      </View>
    </Screen>
  );
}
