/** The room header's live status: the phase strip and the spend meter. */
import { ScrollView, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { councilApprox, councilMoney, type RoomWire } from "@relay/protocol";
import { radii, spacing, toneFill, useColors } from "@/theme";
import { ProgressBar } from "@/ui/ProgressBar";
import { Text } from "@/ui/Text";
import { phaseSteps, spendView } from "./model";

/** Stages as a row of capsules you scroll sideways: done with a check, the current one lit. */
export function PhaseStrip({ room }: { room: RoomWire }) {
  const colors = useColors();
  const steps = phaseSteps(room);
  if (steps.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.sm }} accessibilityLabel="Stages">
      {steps.map((step) => {
        const current = step.state === "current";
        return (
          <View
            key={step.stage}
            accessibilityLabel={`${step.label}, ${step.state === "done" ? "done" : current ? "now" : "later"}`}
            style={{
              minHeight: 36,
              flexDirection: "row",
              alignItems: "center",
              gap: spacing.xs + 2,
              paddingHorizontal: spacing.md,
              borderRadius: 18,
              backgroundColor: current ? colors.accent : toneFill(colors, "textMuted"),
            }}
          >
            {step.state === "done" && <SymbolView name="checkmark" size={12} tintColor={colors.ok} />}
            <Text variant="label" style={{ color: current ? colors.bg : step.state === "done" ? colors.text : colors.textMuted, fontWeight: current ? "700" : "500" }}>
              {step.label}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

/** Spent against the hard cap, with the estimate beside it; amber from 80 % of the cap. */
export function SpendMeter({ room }: { room: RoomWire }) {
  const colors = useColors();
  const council = room.council;
  if (council === undefined) return null;
  const spend = spendView(council);
  return (
    <View accessible accessibilityLabel={`Spent ${councilMoney(spend.usd)} of a ${councilMoney(spend.cap)} cap${spend.warn ? ", close to the cap" : ""}`} style={{ gap: spacing.xs + 2 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.sm }}>
        <Text variant="body" tabular style={{ fontWeight: "600", color: spend.warn ? colors.warn : colors.text }}>
          {councilMoney(spend.usd)}
          <Text variant="label" color="textMuted">{` of ${councilMoney(spend.cap)} cap`}</Text>
        </Text>
        <Text variant="label" color="textMuted" tabular>{`${councilApprox(spend.estimate)} estimated`}</Text>
      </View>
      <ProgressBar fraction={spend.fraction} tone={spend.warn ? "warn" : "accent"} />
      {spend.warn && (
        <View style={{ flexDirection: "row", gap: spacing.xs + 2, alignItems: "center", backgroundColor: toneFill(colors, "warn"), borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 2, alignSelf: "flex-start" }}>
          <SymbolView name="exclamationmark.triangle.fill" size={12} tintColor={colors.warn} />
          <Text variant="label" color="warn">Close to the cap</Text>
        </View>
      )}
    </View>
  );
}
