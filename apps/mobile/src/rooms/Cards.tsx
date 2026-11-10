/**
 * The cards a council room posts into its feed: contract, parts board, scorecard (with the routing
 * log folded under it), pause, ask and the deliverable. Everything is stacked rows or a two-column
 * grid, never a wide table, so it reads at 375pt.
 */
import { useState } from "react";
import { View } from "react-native";
import {
  COUNCIL_HARNESS_LABEL,
  COUNCIL_MODELS,
  COUNCIL_TARGET_SCORE,
  councilMoney,
  type RoomWire,
  type RoomWireCard,
  type RoomWireRoutingEntry,
} from "@relay/protocol";
import { copyText } from "@/lib/clipboard";
import { radii, spacing, toneFill, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { Collapse } from "@/ui/Collapse";
import { ProgressBar } from "@/ui/ProgressBar";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { authorOf, deltaLabel, scoreMet } from "./model";
import { Block, TAP, Tag } from "./primitives";
import { RenderThumb } from "./RoomImage";

/** What the buttons on a card do; each resolves to an error to show, or null when it worked. */
export interface CardActions {
  budget: (choice: "continue" | "wrap") => Promise<string | null>;
  answer: (askId: string, allow: boolean) => Promise<string | null>;
}

type Of<T extends RoomWireCard["type"]> = Extract<RoomWireCard, { type: T }>;

const VERDICT: Record<Of<"scorecard">["verdict"], string> = {
  continue: "Next round", converged: "Converged", plateau: "Plateaued", cap: "Round cap reached", branch: "Branch picked", stopped: "Stopped",
};
const PART_STATUS: Record<Of<"parts">["parts"][number]["status"], { label: string; tone: "ok" | "danger" | "warn" }> = {
  ok: { label: "Built", tone: "ok" }, failed: { label: "Failed", tone: "danger" }, bounced: { label: "Sent back", tone: "warn" },
};

function ContractCard({ card }: { card: Of<"contract"> }) {
  return (
    <Block>
      <Collapse title={`Contract v${String(card.version)}`}>
        <Text variant="label" color="textMuted" selectable>{card.path}</Text>
        <Text variant="body" selectable>{card.text}</Text>
      </Collapse>
    </Block>
  );
}

function PartsCard({ room, card }: { room: RoomWire; card: Of<"parts"> }) {
  const colors = useColors();
  return (
    <Block>
      <Text variant="title">{`Round ${String(card.round)} parts`}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {card.parts.map((p, i) => {
          const status = PART_STATUS[p.status];
          return (
            <View key={`${p.part}-${p.branch ?? ""}-${String(i)}`} style={{ flexBasis: "47.5%", flexGrow: 1, gap: spacing.sm, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surfaceRaised }}>
              {p.render !== undefined && <RenderThumb roomId={room.id} path={p.render} width="100%" label={p.part} caption="" />}
              <Text variant="body" style={{ fontWeight: "600" }}>{p.branch === undefined ? p.part : `${p.part} ${p.branch}`}</Text>
              <Tag label={status.label} tone={status.tone} />
              <Text variant="label" color="textMuted">{authorOf(room, p.agentId).name}</Text>
              {p.note !== "" && <Text variant="label">{p.note}</Text>}
            </View>
          );
        })}
      </View>
    </Block>
  );
}

function LogRow({ room, entry }: { room: RoomWire; entry: RoomWireRoutingEntry }) {
  const tokens = entry.tokens.input + entry.tokens.output + entry.tokens.cached;
  return (
    <View style={{ gap: 2, paddingVertical: spacing.xs }}>
      <Text variant="body">
        {authorOf(room, entry.seat).name}
        <Text variant="label" color="textMuted">{`  ${entry.kind}${entry.part === undefined ? "" : ` · ${entry.part}`}`}</Text>
      </Text>
      <Text variant="label" color="textMuted" tabular>
        {`${COUNCIL_MODELS[entry.model].short} · ${COUNCIL_HARNESS_LABEL[entry.harness]} · ${councilMoney(entry.usd)} · ${String(Math.round(tokens / 1000))}k tokens`}
      </Text>
    </View>
  );
}

function ScorecardCard({ room, card }: { room: RoomWire; card: Of<"scorecard"> }) {
  return (
    <Block>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
        <Text variant="title">{`Round ${String(card.round)} scorecard`}</Text>
        <Text variant="title" tabular>
          {card.total.toFixed(1)}
          <Text variant="label" color="textMuted">{` / 10`}</Text>
        </Text>
      </View>
      <Tag label={VERDICT[card.verdict]} tone={card.verdict === "converged" ? "ok" : "accent"} />
      <View style={{ gap: spacing.lg }}>
        {card.criteria.map((c) => {
          const delta = deltaLabel(c.delta);
          return (
            <View key={c.id} style={{ gap: spacing.xs + 2 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
                <Text variant="body" style={{ flex: 1 }}>{c.name}</Text>
                {delta !== null && <Text variant="label" tabular color={(c.delta ?? 0) > 0 ? "ok" : "danger"}>{delta}</Text>}
                <Text variant="body" tabular style={{ fontWeight: "600", minWidth: 32, textAlign: "right" }}>{c.score.toFixed(1)}</Text>
              </View>
              <ProgressBar fraction={c.score / 10} tone={scoreMet(c.score) ? "ok" : "accent"} />
              <Text variant="label" color="textMuted">{`Owner: ${c.owner}${scoreMet(c.score) ? "" : ` · target ${String(COUNCIL_TARGET_SCORE)}`}`}</Text>
            </View>
          );
        })}
      </View>
      {card.note !== "" && <Text variant="body">{card.note}</Text>}
      {card.fixes.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <Separator />
          <Text variant="label" color="textMuted" style={{ marginTop: spacing.xs }}>Top fixes</Text>
          {card.fixes.map((f, i) => (
            <View key={`${f.part}-${String(i)}`} style={{ gap: 2 }}>
              <Tag label={f.part} tone="accent" />
              <Text variant="body">{f.text}</Text>
            </View>
          ))}
        </View>
      )}
      {card.log.length > 0 && (
        <>
          <Separator />
          <Collapse title="Routing log" count={card.log.length}>
            {card.log.map((entry, i) => (
              <LogRow key={`${entry.seat}-${String(i)}`} room={room} entry={entry} />
            ))}
          </Collapse>
        </>
      )}
    </Block>
  );
}

function PauseCard({ card, actions }: { card: Of<"pause">; actions: CardActions }) {
  const colors = useColors();
  const [busy, setBusy] = useState<"continue" | "wrap" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async (choice: "continue" | "wrap"): Promise<void> => {
    setBusy(choice);
    setError(await actions.budget(choice));
    setBusy(null);
  };
  return (
    <Block style={{ backgroundColor: toneFill(colors, "warn", 0.1), borderColor: colors.warn }}>
      <Text variant="title">Over budget soon</Text>
      <Text variant="body">{`${councilMoney(card.spent)} spent of the ${councilMoney(card.cap)} cap. Continue to ${councilMoney(card.nextCap)} or wrap now?`}</Text>
      {card.answered === undefined ? (
        <View style={{ gap: spacing.sm }}>
          <Button label={`Continue to ${councilMoney(card.nextCap)}`} height={TAP + 4} loading={busy === "continue"} disabled={busy !== null} onPress={() => void go("continue")} />
          <Button label="Wrap now" variant="secondary" height={TAP + 4} loading={busy === "wrap"} disabled={busy !== null} onPress={() => void go("wrap")} />
        </View>
      ) : (
        <Text variant="label" color="textMuted">{card.answered === "continue" ? `You chose to continue to ${councilMoney(card.nextCap)}.` : "You chose to wrap now."}</Text>
      )}
      {error !== null && <Text variant="label" color="danger">{error}</Text>}
    </Block>
  );
}

function AskCard({ room, card, actions }: { room: RoomWire; card: Of<"ask">; actions: CardActions }) {
  const [busy, setBusy] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async (allow: boolean): Promise<void> => {
    setBusy(allow);
    setError(await actions.answer(card.askId, allow));
    setBusy(null);
  };
  return (
    <Block>
      <Text variant="title">{`${authorOf(room, card.agentId).name} wants to act outside the room`}</Text>
      <Text variant="body" selectable>{card.action}</Text>
      {card.answered === undefined ? (
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Button label="Allow" height={TAP + 4} loading={busy === true} disabled={busy !== null} onPress={() => void go(true)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Deny" variant="secondary" height={TAP + 4} loading={busy === false} disabled={busy !== null} onPress={() => void go(false)} />
          </View>
        </View>
      ) : (
        <Tag label={card.answered === "allow" ? "Allowed" : "Denied"} tone={card.answered === "allow" ? "ok" : "danger"} />
      )}
      {error !== null && <Text variant="label" color="danger">{error}</Text>}
    </Block>
  );
}

function BeforeAfter({ room, before, after }: { room: RoomWire; before: Of<"deliverable">["before"]; after: Of<"deliverable">["after"] }) {
  const rows = Math.max(before.length, after.length);
  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <Text variant="label" color="textMuted" style={{ flex: 1 }}>Before</Text>
        <Text variant="label" color="textMuted" style={{ flex: 1 }}>After</Text>
      </View>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: "row", gap: spacing.md }}>
          <View style={{ flex: 1 }}>{before[i] !== undefined && <RenderThumb roomId={room.id} path={before[i].path} caption={before[i].caption} width="100%" label="Before" />}</View>
          <View style={{ flex: 1 }}>{after[i] !== undefined && <RenderThumb roomId={room.id} path={after[i].path} caption={after[i].caption} width="100%" label="After" />}</View>
        </View>
      ))}
    </View>
  );
}

function DeliverableCard({ room, card }: { room: RoomWire; card: Of<"deliverable"> }) {
  const colors = useColors();
  const [copied, setCopied] = useState(false);
  const final = room.council?.scores[room.council.scores.length - 1]?.total;
  return (
    <Block style={{ gap: spacing.lg }}>
      <Text variant="title">Delivered</Text>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {[
          ["Score", final === undefined ? card.total.toFixed(1) : final.toFixed(1)],
          ["Spent", councilMoney(card.spent)],
          ["Time", `${String(Math.round(card.minutes))} min`],
        ].map(([label, value]) => (
          <View key={label} style={{ flex: 1, backgroundColor: colors.surfaceRaised, borderRadius: radii.md, padding: spacing.md, gap: 2 }}>
            <Text variant="label" color="textMuted">{label}</Text>
            <Text variant="title" tabular>{value}</Text>
          </View>
        ))}
      </View>
      {(card.before.length > 0 || card.after.length > 0) && <BeforeAfter room={room} before={card.before} after={card.after} />}
      {card.changes.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <Text variant="label" color="textMuted">What changed</Text>
          {card.changes.map((c, i) => (
            <View key={i} style={{ flexDirection: "row", gap: spacing.sm }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textMuted, marginTop: 8 }} />
              <Text variant="body" style={{ flex: 1 }}>{c}</Text>
            </View>
          ))}
        </View>
      )}
      {card.dissent.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <Text variant="label" color="textMuted">Dissent</Text>
          {card.dissent.map((d, i) => (
            <Text key={i} variant="body">{d}</Text>
          ))}
        </View>
      )}
      <View style={{ gap: spacing.sm }}>
        <Text variant="label" color="textMuted">Who did what</Text>
        {card.who.map((w, i) => (
          <View key={`${w.agentId}-${String(i)}`} style={{ gap: spacing.xs }}>
            <Separator />
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm }}>
              <Text variant="body" style={{ fontWeight: "600" }}>{authorOf(room, w.agentId).name}</Text>
              {w.part !== undefined && <Tag label={w.part} tone="accent" />}
              <View style={{ flex: 1 }} />
              <Text variant="body" tabular>{councilMoney(w.usd)}</Text>
            </View>
            <Text variant="body">{w.did}</Text>
            <Text variant="label" color="textMuted">{`${String(w.turns)} ${w.turns === 1 ? "turn" : "turns"}${w.moved === "" ? "" : ` · ${w.moved}`}`}</Text>
          </View>
        ))}
      </View>
      <View style={{ gap: spacing.sm }}>
        <Separator />
        <Text variant="label" color="textMuted" style={{ marginTop: spacing.sm }}>Work folder on your Mac</Text>
        <Text variant="body" selectable>{card.workdir}</Text>
        <Text variant="label" color="textMuted">Nothing was copied back to the source. Merge what you want by hand.</Text>
        <Button
          label={copied ? "Copied" : "Copy path"}
          variant="secondary"
          height={TAP}
          symbol="doc.on.doc"
          onPress={() => {
            void copyText(card.workdir).then(() => {
              setCopied(true);
            });
          }}
        />
      </View>
    </Block>
  );
}

export function RoomCard({ room, card, actions }: { room: RoomWire; card: RoomWireCard; actions: CardActions }) {
  switch (card.type) {
    case "contract":
      return <ContractCard card={card} />;
    case "parts":
      return <PartsCard room={room} card={card} />;
    case "scorecard":
      return <ScorecardCard room={room} card={card} />;
    case "pause":
      return <PauseCard card={card} actions={actions} />;
    case "ask":
      return <AskCard room={room} card={card} actions={actions} />;
    case "deliverable":
      return <DeliverableCard room={room} card={card} />;
  }
}
