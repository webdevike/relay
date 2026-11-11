/** One entry of a room's feed: a seat's or member's message, Isaac's, the room's quiet note, the summary, or a card. */
import { View } from "react-native";
import { COUNCIL_HARNESS_LABEL, COUNCIL_MODELS, COUNCIL_ROLE_LABEL, COUNCIL_WHOLE, type RoomWire, type RoomWireMessage } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { spacing } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { RoomCard, type CardActions } from "./Cards";
import { authorOf } from "./model";
import { Block, Tag } from "./primitives";
import { RenderThumb } from "./RoomImage";
import { SeatAvatar } from "./SeatList";

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function MessageRow({ room, message, actions }: { room: RoomWire; message: RoomWireMessage; actions: CardActions }) {
  if (message.kind === "card" && message.card !== undefined) {
    return (
      <View style={{ paddingHorizontal: spacing.lg }}>
        <RoomCard room={room} card={message.card} actions={actions} />
      </View>
    );
  }
  // A chat room's own notes ("Penny joined as a guest", "Paused ..."): one quiet centered line.
  if (room.chat !== undefined && message.author === "system") {
    return (
      <Text variant="label" color="textMuted" style={{ paddingHorizontal: spacing.lg, textAlign: "center" }}>
        {message.text}
      </Text>
    );
  }
  const author = authorOf(room, message.author);
  const seat = author.agent?.seat;
  const member = room.chat?.setup.members.find((m) => m.id === message.author);
  const summary = message.kind === "summary";
  const body = (
    <View style={{ flex: 1, gap: spacing.xs + 2 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm }}>
        <Text variant="body" style={{ fontWeight: "700" }}>{summary ? `${author.name}: summary` : author.name}</Text>
        {seat !== undefined && <Tag label={COUNCIL_ROLE_LABEL[seat.role]} />}
        {member !== undefined && member.role !== "" && <Tag label={member.role} />}
        {(message.part ?? seat?.part) !== undefined && (message.part ?? seat?.part) !== COUNCIL_WHOLE && <Tag label={message.part ?? seat?.part ?? ""} tone="accent" />}
        <Text variant="label" color="textFaint">{CLOCK.format(message.ts)}</Text>
      </View>
      {seat !== undefined && (
        <Text variant="label" color="textMuted">{`${COUNCIL_MODELS[seat.modelKey].name} · ${COUNCIL_HARNESS_LABEL[seat.harness]}`}</Text>
      )}
      <MessageText text={message.text} />
      {message.renders !== undefined && message.renders.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs }}>
          {message.renders.map((r) => (
            <RenderThumb key={r.path} roomId={room.id} path={r.path} caption={r.caption} width={132} />
          ))}
        </View>
      )}
    </View>
  );
  const avatar =
    seat !== undefined ? (
      <SeatAvatar seat={{ name: author.name, color: author.color ?? "#9A9AA3", model: seat.modelKey }} size={40} />
    ) : (
      <Avatar name={author.name} size={40} {...(author.color === undefined ? {} : { tint: author.color })} />
    );
  return (
    <View style={{ paddingHorizontal: spacing.lg }}>
      {summary ? (
        <Block>{body}</Block>
      ) : (
        <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "flex-start" }}>
          {avatar}
          {body}
        </View>
      )}
    </View>
  );
}
