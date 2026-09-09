import { Switch, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Screen } from "@/ui/Screen";
import { Row } from "@/ui/Row";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { colors, spacing } from "@/theme";
import { useConnectionStore } from "@/state/connection";
import { useSettingsStore, type PointerSpeed } from "@/state/settings";
import { actions } from "@/state/actions";

const speeds: PointerSpeed[] = ["slow", "normal", "fast"];

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
