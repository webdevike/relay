import { useState } from "react";
import { Switch, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Screen } from "@/ui/Screen";
import { Row } from "@/ui/Row";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { colors, radii, spacing, type } from "@/theme";
import { useConnectionStore } from "@/state/connection";
import { useSettingsStore, type PointerSpeed, type Recognizer } from "@/state/settings";
import { actions } from "@/state/actions";
import { MANUAL_HOST_PLACEHOLDER, parseManualHost } from "@/connection/manual-host";
import { setNotificationsEnabled } from "@/notifications";
import { warmVoz } from "@/dictation/actor";
import { VozDictation } from "../modules/voz-dictation";

const speeds: PointerSpeed[] = ["slow", "normal", "fast"];
const recognizers: { value: Recognizer; label: string }[] = [
  { value: "voz", label: "Voz" },
  { value: "apple", label: "Apple" },
];

/**
 * Committed on blur/submit, not per keystroke: every committed change restarts the connection.
 */
function HostAddressField() {
  const manualHost = useSettingsStore((state) => state.manualHost);
  const set = useSettingsStore((state) => state.set);
  const [draft, setDraft] = useState(manualHost);
  const invalid = draft.trim().length > 0 && parseManualHost(draft) === null;

  const commit = () => {
    const next = invalid ? "" : draft.trim();
    setDraft(next);
    if (next !== manualHost) set({ manualHost: next });
  };

  return (
    <View style={{ paddingHorizontal: spacing.xl, paddingVertical: spacing.md, gap: spacing.sm }}>
      <Text variant="title">Host address</Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        placeholder={`Automatic, or ${MANUAL_HOST_PLACEHOLDER}`}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        style={{
          ...type.body,
          color: invalid ? colors.danger : colors.text,
          backgroundColor: colors.surface,
          borderRadius: radii.md,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
        }}
      />
      <Text variant="caption" color={invalid ? "danger" : "textMuted"}>
        {invalid
          ? "Enter host:port, for example 192.168.1.20:7817."
          : "Macs are found automatically. Enter host:port for a Linux host or to connect over Tailscale."}
      </Text>
    </View>
  );
}

/** The switch only lands on when the system permission is granted; a refusal snaps it back. */
function NotificationsRow() {
  const enabled = useSettingsStore((state) => state.notificationsEnabled);
  const [refused, setRefused] = useState(false);
  return (
    <Row
      title="Notifications"
      subtitle={refused ? "Allow notifications for Relay in iOS Settings" : "When a session waits on you"}
      leading={<SymbolView name="bell.badge" size={22} tintColor={colors.textMuted} />}
      trailing={
        <Switch
          value={enabled}
          onValueChange={(value) => {
            void setNotificationsEnabled(value).then((ok) => {
              setRefused(value && !ok);
            });
          }}
        />
      }
    />
  );
}

/**
 * Apple dictation or Voz. Voz needs its 467 MB model once; until it is on the phone every hold
 * still goes to Apple, and the caption says so.
 */
function RecognizerField() {
  const recognizer = useSettingsStore((state) => state.recognizer);
  const set = useSettingsStore((state) => state.set);
  const [downloaded, setDownloaded] = useState(() => VozDictation.isDownloaded());
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const download = () => {
    setFailed(false);
    setProgress(0);
    const subscription = VozDictation.addListener("downloadProgress", (event) => {
      setProgress(event.fraction);
    });
    VozDictation.download().then(
      () => {
        subscription.remove();
        setProgress(null);
        setDownloaded(true);
        warmVoz();
      },
      () => {
        subscription.remove();
        setProgress(null);
        setFailed(true);
      },
    );
  };

  const caption =
    recognizer === "apple"
      ? "iOS dictation, words appear as you speak"
      : downloaded
        ? "On device, transcribed when you let go. Voz by Desert Ant Labs."
        : progress !== null
          ? `Downloading model, ${Math.round(progress * 100)}%`
          : failed
            ? "Download failed. Using iOS dictation until it succeeds."
            : "Needs the 467 MB model. Using iOS dictation until then.";

  return (
    <View style={{ paddingHorizontal: spacing.xl, paddingVertical: spacing.md, gap: spacing.md }}>
      <Text variant="title">Speech recognition</Text>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {recognizers.map((option) => (
          <Button
            key={option.value}
            label={option.label}
            variant={recognizer === option.value ? "primary" : "secondary"}
            onPress={() => {
              set({ recognizer: option.value });
              if (option.value === "voz") warmVoz();
            }}
          />
        ))}
        {recognizer === "voz" && !downloaded && progress === null && <Button label="Download" variant="secondary" onPress={download} />}
      </View>
      <Text variant="caption" color={failed ? "danger" : "textMuted"}>
        {caption}
      </Text>
    </View>
  );
}

export default function Settings() {
  const macName = useConnectionStore((state) => state.macName);
  const status = useConnectionStore((state) => state.status);
  const settings = useSettingsStore();

  return (
    <Screen title="Settings">
      <Separator />
      <Row
        title={macName ?? "No Mac paired"}
        subtitle={status === "connected" ? "Connected" : "Not connected"}
        leading={<SymbolView name="desktopcomputer" size={22} tintColor={colors.textMuted} />}
        trailing={
          macName !== null ? (
            <Button
              label="Forget"
              variant="ghost"
              onPress={() => {
                actions.forgetMac();
              }}
            />
          ) : undefined
        }
      />
      <Separator />
      <Row
        title="Device name"
        subtitle={settings.deviceName}
        leading={<SymbolView name="iphone" size={22} tintColor={colors.textMuted} />}
      />
      <Separator />
      <Row
        title="Haptics"
        leading={<SymbolView name="hand.tap" size={22} tintColor={colors.textMuted} />}
        trailing={
          <Switch
            value={settings.hapticsEnabled}
            onValueChange={(value) => {
              settings.set({ hapticsEnabled: value });
            }}
          />
        }
      />
      <Separator />
      <Row
        title="Natural scrolling"
        leading={<SymbolView name="scroll" size={22} tintColor={colors.textMuted} />}
        trailing={
          <Switch
            value={settings.naturalScrolling}
            onValueChange={(value) => {
              settings.set({ naturalScrolling: value });
            }}
          />
        }
      />
      <Separator />
      <Row
        title="Skill wheel"
        subtitle="Swipe left while holding the inbox mic"
        leading={<SymbolView name="dial.medium" size={22} tintColor={colors.textMuted} />}
        trailing={
          <Switch
            value={settings.skillWheelEnabled}
            onValueChange={(value) => {
              settings.set({ skillWheelEnabled: value });
            }}
          />
        }
      />
      <Separator />
      <NotificationsRow />
      <Separator />
      <RecognizerField />
      <Separator />
      <View style={{ paddingHorizontal: spacing.xl, paddingVertical: spacing.md, gap: spacing.md }}>
        <Text variant="title">Pointer speed</Text>
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {speeds.map((speed) => (
            <Button
              key={speed}
              label={speed}
              variant={settings.pointerSpeed === speed ? "primary" : "secondary"}
              onPress={() => {
                settings.set({ pointerSpeed: speed });
              }}
            />
          ))}
        </View>
      </View>
      <Separator />
      <HostAddressField />
      <Separator />
    </Screen>
  );
}
