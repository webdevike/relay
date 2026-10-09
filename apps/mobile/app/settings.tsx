import { useEffect, useState } from "react";
import { Switch, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Screen } from "@/ui/Screen";
import { Row } from "@/ui/Row";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { radii, spacing, type, useColors, useScheme } from "@/theme";
import { useConnectionStore } from "@/state/connection";
import { useSettingsStore, type AppearanceChoice, type PointerSpeed, type Recognizer } from "@/state/settings";
import { actions } from "@/state/actions";
import { MANUAL_HOST_PLACEHOLDER, parseManualHost } from "@/connection/manual-host";
import { browseHosts } from "@/connection";
import { setNotificationsEnabled } from "@/notifications";
import { warmVoz } from "@/dictation/actor";
import { VozDictation } from "../modules/voz-dictation";

const speeds: PointerSpeed[] = ["slow", "normal", "fast"];
const recognizers: { value: Recognizer; label: string }[] = [
  { value: "voz", label: "Voz" },
  { value: "apple", label: "Apple" },
];
const appearances: { value: AppearanceChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Saved computers (tap to switch, Forget each), Bonjour hosts not yet paired, and add-by-address. */
function HostsSection() {
  const colors = useColors();
  const scheme = useScheme();
  const hosts = useConnectionStore((state) => state.hosts);
  const activeId = useConnectionStore((state) => state.activeHostId);
  const status = useConnectionStore((state) => state.status);
  const discovered = useConnectionStore((state) => state.discovered);
  const [draft, setDraft] = useState("");
  const invalid = draft.trim().length > 0 && parseManualHost(draft) === null;

  useEffect(() => {
    browseHosts(true);
    return () => {
      browseHosts(false);
    };
  }, []);

  const unpaired = discovered.filter((service) => !hosts.some((host) => host.id === service.name));
  const add = () => {
    const next = draft.trim();
    if (next === "" || invalid) return;
    setDraft("");
    actions.switchHost(next);
  };

  return (
    <>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md }}>
        <Text variant="title">Computers</Text>
      </View>
      {hosts.length === 0 && unpaired.length === 0 ? (
        <Row title="No computers yet" subtitle="Searching the network, or add one by address below" />
      ) : null}
      {hosts.map((host) => {
        const active = host.id === activeId;
        return (
          <View key={host.id}>
            <Row
              title={host.name}
              subtitle={`${active ? (status === "connected" ? "Connected" : "Connecting") : "Tap to switch"}${host.address ? ` · ${host.address}` : ""}`}
              leading={
                <SymbolView
                  name={active ? "checkmark.circle.fill" : "desktopcomputer"}
                  size={22}
                  tintColor={active ? colors.accent : colors.textMuted}
                />
              }
              onPress={() => {
                actions.switchHost(host.id);
              }}
              trailing={
                <Button
                  label="Forget"
                  variant="ghost"
                  onPress={() => {
                    actions.forgetHost(host.id);
                  }}
                />
              }
            />
            <Separator />
          </View>
        );
      })}
      {unpaired.map((service) => (
        <View key={service.name}>
          <Row
            title={service.name}
            subtitle={service.name === activeId ? "Pairing: enter the PIN shown on the computer" : "Found nearby · tap to pair"}
            leading={<SymbolView name="plus.circle" size={22} tintColor={colors.textMuted} />}
            onPress={() => {
              actions.switchHost(service.name);
            }}
          />
          <Separator />
        </View>
      ))}
      <View style={{ paddingHorizontal: spacing.xl, paddingVertical: spacing.md, gap: spacing.sm }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          placeholder={`Add by address, ${MANUAL_HOST_PLACEHOLDER}`}
          placeholderTextColor={colors.textFaint}
          keyboardAppearance={scheme}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
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
            : "Use host:port for a Linux host or to connect over Tailscale."}
        </Text>
      </View>
    </>
  );
}

/** The switch only lands on when the system permission is granted; a refusal snaps it back. */
function NotificationsRow() {
  const colors = useColors();
  const enabled = useSettingsStore((state) => state.notificationsEnabled);
  const [refused, setRefused] = useState(false);
  return (
    <Row
      title="Notifications"
      subtitle={
        refused ? "Allow notifications for Relay in iOS Settings" : "When a session waits on you"
      }
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
        {recognizer === "voz" && !downloaded && progress === null && (
          <Button label="Download" variant="secondary" onPress={download} />
        )}
      </View>
      <Text variant="caption" color={failed ? "danger" : "textMuted"}>
        {caption}
      </Text>
    </View>
  );
}

function AppearanceField() {
  const appearance = useSettingsStore((state) => state.appearance);
  const set = useSettingsStore((state) => state.set);
  return (
    <View style={{ paddingHorizontal: spacing.xl, paddingVertical: spacing.md, gap: spacing.md }}>
      <Text variant="title">Appearance</Text>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {appearances.map((option) => (
          <Button
            key={option.value}
            label={option.label}
            variant={appearance === option.value ? "primary" : "secondary"}
            onPress={() => {
              set({ appearance: option.value });
            }}
          />
        ))}
      </View>
      <Text variant="caption" color="textMuted">
        System follows your iPhone's light or dark setting.
      </Text>
    </View>
  );
}

/** omp's thinking selectors; a model that lacks one keeps its own default (the bridge validates). */
const thinkingLevels = ["", "off", "low", "medium", "high", "xhigh"] as const;

function ThinkingField() {
  const level = useSettingsStore((state) => state.defaultThinkingLevel);
  const set = useSettingsStore((state) => state.set);
  return (
    <View style={{ paddingHorizontal: spacing.xl, paddingVertical: spacing.md, gap: spacing.md }}>
      <Text variant="title">Default thinking</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {thinkingLevels.map((option) => (
          <Button
            key={option}
            label={option === "" ? "omp default" : option}
            variant={level === option ? "primary" : "secondary"}
            onPress={() => {
              set({ defaultThinkingLevel: option });
            }}
          />
        ))}
      </View>
      <Text variant="caption" color="textMuted">
        Applied to sessions you start from the phone. A model without that level keeps its own.
      </Text>
    </View>
  );
}

export default function Settings() {
  const colors = useColors();
  const settings = useSettingsStore();

  return (
    <Screen title="Settings" scroll>
      <HostsSection />
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
      <AppearanceField />
      <Separator />
      <NotificationsRow />
      <Separator />
      <RecognizerField />
      <Separator />
      <ThinkingField />
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
    </Screen>
  );
}
