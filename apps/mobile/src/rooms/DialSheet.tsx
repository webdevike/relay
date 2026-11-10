/**
 * The effort dial as a bottom sheet: the stepped slider, what the notch costs and how long it
 * takes, a provider picker per role, the parts row and the seat list. Before Start it edits the
 * new room's notch and routing; on a running room it is read-only except "Raise one notch" (the
 * dial only goes up once a room runs). A plain Modal, not the gorhom sheet: the slider's drag would
 * fight that sheet's pan.
 */
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  COUNCIL_DEFAULT_EFFORT,
  COUNCIL_MAX_EFFORT,
  COUNCIL_PAUSE_AT,
  COUNCIL_ROLE_LABEL,
  COUNCIL_ROUTE_LABEL,
  councilApprox,
  councilCast,
  councilLabel,
  councilMoney,
  councilNotch,
  councilTime,
  type CouncilProvider,
  type CouncilRouting,
} from "@relay/protocol";
import { radii, spacing, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { EffortSlider } from "./EffortSlider";
import { seatsOfCast, type SeatView } from "./model";
import { Block, PROVIDER_NAME, Segmented, SectionHead, TAP } from "./primitives";
import { PartsRow, SeatList } from "./SeatList";

export interface DialSheetProps {
  visible: boolean;
  onClose: () => void;
  effort: number;
  routing: CouncilRouting;
  /** Present while the dial is editable (a new room). */
  onChange?: ((next: { effort: number; routing: CouncilRouting }) => void) | undefined;
  /** The running room's actual seats, when they are what to show instead of the cast. */
  seats?: readonly SeatView[] | undefined;
  /** The running room's parts. */
  parts?: readonly string[] | undefined;
  /** A running room: one notch up, if there is one. */
  raise?: { busy: boolean; error: string | null; onRaise: () => void } | undefined;
}

const PROVIDERS = [
  { key: "anthropic", label: PROVIDER_NAME.anthropic },
  { key: "openai", label: PROVIDER_NAME.openai },
] as const;

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  const colors = useColors();
  return (
    <View style={{ flexBasis: "47%", flexGrow: 1, backgroundColor: colors.surfaceRaised, borderRadius: radii.md, padding: spacing.md, gap: 2 }}>
      <Text variant="label" color="textMuted">{label}</Text>
      <Text variant="title" tabular>{value}</Text>
      {note !== undefined && <Text variant="label" color="textMuted" tabular>{note}</Text>}
    </View>
  );
}

export function DialSheet({ visible, onClose, effort, routing, onChange, seats, parts, raise }: DialSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const cast = councilCast(effort, routing);
  const shown = seats ?? seatsOfCast(cast);
  const shownParts = parts ?? cast.parts;
  const editable = onChange !== undefined;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)" }} />
        <View style={{ maxHeight: "92%", backgroundColor: colors.bg, borderTopLeftRadius: radii.lg + 6, borderTopRightRadius: radii.lg + 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: spacing.xl, paddingRight: spacing.sm, paddingTop: spacing.md }}>
            <Text variant="title" style={{ flex: 1 }}>Effort</Text>
            <IconButton symbol="xmark" size={TAP} glyphSize={16} accessibilityLabel="Close" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.xl, gap: spacing.xl }} showsVerticalScrollIndicator={false}>
            <View style={{ gap: spacing.xs }}>
              <Text variant="largeTitle" accessibilityRole="header">{councilLabel(effort)}</Text>
              <Text variant="body" color="textMuted">{cast.notch.blurb}</Text>
            </View>

            <View style={{ gap: spacing.sm }}>
              <EffortSlider
                value={effort}
                disabled={!editable}
                onChange={(next) => {
                  onChange?.({ effort: next, routing });
                }}
              />
              {editable && effort !== COUNCIL_DEFAULT_EFFORT && (
                <Button
                  label={`Back to ${councilNotch(COUNCIL_DEFAULT_EFFORT).name}`}
                  variant="ghost"
                  height={TAP}
                  symbol="arrow.counterclockwise"
                  onPress={() => {
                    onChange({ effort: COUNCIL_DEFAULT_EFFORT, routing });
                  }}
                />
              )}
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
              <Figure label="Cost" value={councilApprox(cast.cost)} note={`${councilMoney(cast.costLow)} to ${councilMoney(cast.costHigh)}`} />
              <Figure label="Time" value={councilTime(cast.minutes)} note={`${String(cast.minutesLow)} to ${String(cast.minutesHigh)} min`} />
              <Figure label="Rounds" value={`Up to ${String(cast.notch.rounds)}`} note="Stops early when it converges" />
              <Figure label="Seats" value={String(cast.seats.length)} note={`${String(cast.providers)} ${cast.providers === 1 ? "provider" : "providers"}, ${String(cast.harnesses)} ${cast.harnesses === 1 ? "harness" : "harnesses"}`} />
            </View>
            <Text variant="label" color="textMuted">
              {`Hard cap ${councilMoney(cast.cap)}. The room pauses at ${String(Math.round(COUNCIL_PAUSE_AT * 100))} % of it and asks before it spends more.`}
            </Text>

            <View style={{ gap: spacing.md }}>
              <SectionHead title="Routing" note="Which family does each kind of work. Moving a role changes its seats and the cost." />
              <Block style={{ gap: spacing.lg }}>
                {cast.roles.map((role, i) => (
                  <View key={role} style={{ gap: spacing.sm }}>
                    {i > 0 && <Separator />}
                    <View style={{ gap: 2, marginTop: i > 0 ? spacing.sm : 0 }}>
                      <Text variant="body" style={{ fontWeight: "600", textTransform: "capitalize" }}>{COUNCIL_ROLE_LABEL[role]}</Text>
                      <Text variant="label" color="textMuted">{COUNCIL_ROUTE_LABEL[role]}</Text>
                    </View>
                    <Segmented<CouncilProvider>
                      label={`${COUNCIL_ROLE_LABEL[role]} provider`}
                      options={PROVIDERS}
                      value={routing[role]}
                      disabled={!editable}
                      onChange={(provider) => {
                        onChange?.({ effort, routing: { ...routing, [role]: provider } });
                      }}
                    />
                  </View>
                ))}
              </Block>
            </View>

            <View style={{ gap: spacing.md }}>
              <SectionHead title={shownParts.length > 1 ? `${String(shownParts.length)} parts, built in parallel` : "Parts"} />
              <PartsRow parts={shownParts} seats={shown} />
            </View>

            <View style={{ gap: spacing.md }}>
              <SectionHead title="Seats" note="Each seat is a model in a harness, with its own worktree and full tools." />
              <SeatList seats={shown} />
            </View>

            {raise !== undefined && (
              <View style={{ gap: spacing.sm }}>
                <Button
                  label={effort >= COUNCIL_MAX_EFFORT ? "Already at the top" : `Raise one notch to ${councilLabel(effort + 1)}`}
                  height={TAP + 4}
                  symbol="arrow.up"
                  loading={raise.busy}
                  disabled={effort >= COUNCIL_MAX_EFFORT}
                  onPress={raise.onRaise}
                />
                <Text variant="label" color="textMuted">New seats join at the next round and read the whole feed. A running room only goes up.</Text>
                {raise.error !== null && <Text variant="label" color="danger">{raise.error}</Text>}
              </View>
            )}
            {editable && <Button label="Done" height={TAP + 4} onPress={onClose} />}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
