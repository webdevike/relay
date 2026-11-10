/** The seat list and the parts row of the dial: who sits in the room and who builds which part. */
import { View } from "react-native";
import { COUNCIL_HARNESS_LABEL, COUNCIL_MODELS, COUNCIL_ROLE_LABEL, COUNCIL_THINKING_LABEL, COUNCIL_WHOLE } from "@relay/protocol";
import { spacing, useColors } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { buildersOf, lookOf, modelLine, providerOf, type SeatView } from "./model";
import { Block, PROVIDER_LETTER, PROVIDER_NAME, PROVIDER_TINT, Tag } from "./primitives";

const BADGE = 20;

/** An initials avatar with its provider's badge on the corner. */
export function SeatAvatar({ seat, size = 44 }: { seat: Pick<SeatView, "name" | "color" | "model">; size?: number }) {
  const colors = useColors();
  const provider = providerOf(seat.model);
  return (
    <View accessibilityLabel={`${seat.name}, ${PROVIDER_NAME[provider]}`} style={{ width: size, height: size }}>
      <Avatar name={seat.name} size={size} tint={seat.color} />
      <View
        style={{
          position: "absolute",
          right: -4,
          bottom: -4,
          width: BADGE,
          height: BADGE,
          borderRadius: BADGE / 2,
          backgroundColor: PROVIDER_TINT[provider],
          borderWidth: 2,
          borderColor: colors.surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text variant="caption" style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 12, lineHeight: 14 }}>
          {PROVIDER_LETTER[provider]}
        </Text>
      </View>
    </View>
  );
}

export function SeatRow({ seat }: { seat: SeatView }) {
  return (
    <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "flex-start" }}>
      <SeatAvatar seat={seat} />
      <View style={{ flex: 1, gap: spacing.xs }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm }}>
          <Text variant="title">{seat.name}</Text>
          <Tag label={COUNCIL_ROLE_LABEL[seat.role]} />
          {seat.part !== undefined && seat.part !== COUNCIL_WHOLE && <Tag label={seat.branch === undefined ? seat.part : `${seat.part} ${seat.branch}`} tone="accent" />}
          {seat.override && <Tag label="Routing override" tone="warn" />}
        </View>
        <Text variant="label" color="textMuted">
          {`${modelLine(seat, COUNCIL_HARNESS_LABEL)} · ${COUNCIL_THINKING_LABEL[seat.thinking]} thinking`}
        </Text>
      </View>
    </View>
  );
}

export function SeatList({ seats }: { seats: readonly SeatView[] }) {
  return (
    <Block style={{ gap: spacing.lg }}>
      {seats.map((seat, i) => (
        <View key={seat.id} style={{ gap: spacing.lg }}>
          {i > 0 && <Separator />}
          <SeatRow seat={seat} />
        </View>
      ))}
    </Block>
  );
}

function PartSeat({ seat, kind }: { seat: SeatView; kind: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 28 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: seat.color }} />
      <Text variant="body" style={{ flex: 1 }}>
        {seat.name}
        <Text variant="label" color="textMuted">{`  ${kind} · ${COUNCIL_MODELS[seat.model].short} · ${COUNCIL_HARNESS_LABEL[seat.harness]}`}</Text>
      </Text>
      {seat.branch !== undefined && <Text variant="label" style={{ color: colors.textMuted }}>{`Branch ${seat.branch}`}</Text>}
    </View>
  );
}

/** Each part with its builder (and branch B), look seat and the integrator that merges. */
export function PartsRow({ parts, seats }: { parts: readonly string[]; seats: readonly SeatView[] }) {
  const split = parts.length > 1;
  const integrator = seats.find((s) => s.role === "integrator");
  return (
    <Block style={{ gap: spacing.lg }}>
      {integrator !== undefined && (
        <View style={{ gap: spacing.xs }}>
          <PartSeat seat={integrator} kind="integrator" />
          <Text variant="label" color="textMuted">Owns the contract and merges the parts.</Text>
        </View>
      )}
      {!split && integrator === undefined && <Text variant="label" color="textMuted">No split: one builder makes the whole thing.</Text>}
      {parts.map((part) => (
        <View key={part} style={{ gap: spacing.xs }}>
          <Separator />
          <Text variant="title" style={{ marginTop: spacing.sm }}>{part === COUNCIL_WHOLE ? "Whole" : part}</Text>
          {buildersOf(seats, part).map((s) => (
            <PartSeat key={s.id} seat={s} kind="builder" />
          ))}
          {lookOf(seats, part).map((s) => (
            <PartSeat key={s.id} seat={s} kind="look" />
          ))}
        </View>
      ))}
    </Block>
  );
}
