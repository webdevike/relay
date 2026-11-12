/**
 * One room (`/rooms/<id>`). The header carries the title, the effort chip (opens the dial; the only
 * thing it changes is "Raise one notch" while the room runs), the spend meter and the phase strip.
 * Under it the feed: seats' messages with their role, part and model, renders you can open full
 * screen, and the council's cards. Isaac posts from the composer at the bottom (a paused room takes
 * posts for its next round); Resolve now ends the room; a council room pauses at the end of its
 * round and resumes with the same seats (only on a host with ROOMS_RESUME_FEATURE). A chat room
 * (Assistants > Rooms on the Mac, on a host with ROOMS_CHAT_FEATURE) is its members talking: each
 * with its name and role, the room's notes as quiet lines, Pause and Resume, and Isaac posts any time;
 * its decision cards (poll, pros and cons, a question for him, the call) take his taps on a host
 * with ROOMS_DECIDE_FEATURE.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { RoomWireMessage } from "@relay/protocol";
import { requestRooms } from "@/connection";
import { DialSheet } from "@/rooms/DialSheet";
import type { CardActions } from "@/rooms/Cards";
import type { DecisionActions } from "@/rooms/DecisionCards";
import { MessageRow } from "@/rooms/MessageRow";
import { Bar, TAP } from "@/rooms/primitives";
import { NOT_CONFIRMED, RequestNote } from "@/rooms/RequestNote";
import { PhaseStrip, SpendMeter } from "@/rooms/Status";
import { castOfRoom, notchLabel, roomLive, roomStatus, routingOf, runControl, seatsOfRoom } from "@/rooms/model";
import { useRoomsAction } from "@/rooms/useRoomsAction";
import { useRoom, useRoomsStore } from "@/state/rooms";
import { radii, spacing, useColors, useScheme } from "@/theme";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { Screen } from "@/ui/Screen";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";

export default function RoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const scheme = useScheme();
  const router = useRouter();
  const room = useRoom(id);
  const list = useRef<FlatList<RoomWireMessage>>(null);
  const [text, setText] = useState("");
  const [dialOpen, setDialOpen] = useState(false);
  // Each control runs its commands through a request machine, busy until the room frame shows the
  // change: the post until a message lands, raise until the notch moves, the rest until the phase does.
  // The composer keeps its text unless the desktop took the post.
  const post = useRoomsAction(room === undefined ? null : String(room.messages.length), () => { setText(""); });
  const raising = useRoomsAction(room === undefined ? null : notchLabel(room));
  const running = useRoomsAction(room?.phase ?? null);
  const stopping = useRoomsAction(room?.phase ?? null);
  const hostResumes = useRoomsStore((state) => state.resumes);
  const hostDecides = useRoomsStore((state) => state.decides);

  useFocusEffect(
    useCallback(() => {
      requestRooms();
    }, []),
  );

  const actions = useMemo<CardActions>(
    () => ({
      budget: (choice) => ({ op: "budget", roomId: id, choice }),
      answer: (askId, allow) => ({ op: "answer", roomId: id, askId, allow }),
    }),
    [id],
  );
  const decisions = useMemo<DecisionActions | null>(
    () =>
      hostDecides
        ? {
            vote: (cardId, option) => ({ op: "vote", roomId: id, cardId, option }),
            callPoll: (cardId) => ({ op: "callPoll", roomId: id, cardId }),
            reopenPoll: (cardId) => ({ op: "reopenPoll", roomId: id, cardId }),
            answer: (cardId, answer) => ({ op: "answerAsk", roomId: id, cardId, answer }),
            decide: (cardId, action, option) => ({ op: "decide", roomId: id, cardId, action, ...(option === undefined ? {} : { option }) }),
          }
        : null,
    [id, hostDecides],
  );

  const back = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/rooms");
  };
  if (room === undefined) {
    return (
      <Screen header={<Bar title="Room" onBack={back} />}>
        <EmptyState symbol="rectangle.3.group" title="Room not found" body="It may still be loading, or it was removed on your Mac." />
      </Screen>
    );
  }

  const live = roomLive(room);
  // A chat room always takes Isaac's messages: each one starts the members talking.
  const canPost = live || room.phase === "paused" || room.chat !== undefined;
  const council = room.council;
  const control = runControl(room, hostResumes);
  const send = (): void => {
    const body = text.trim();
    if (body === "") return;
    post.run("post", { op: "post", roomId: room.id, text: body });
  };
  const runBusy = running.busy !== null || running.unconfirmed !== null;
  const stop = (
    <View style={{ gap: spacing.xs, alignItems: "flex-start" }}>
      <Button label="Resolve now" variant="secondary" height={TAP} loading={stopping.busy !== null} disabled={stopping.unconfirmed !== null} onPress={() => { stopping.run("stop", { op: "stop", roomId: room.id }); }} />
      <RequestNote action={stopping} />
    </View>
  );
  const chip = notchLabel(room);
  const typing = Object.entries(room.presence).map(([agent, p]) => `${room.agents.find((a) => a.id === agent)?.name ?? "Someone"} is ${p.state}`);

  return (
    <Screen
      header={
        <Bar
          title={room.title === "" ? "Room" : room.title}
          sub={roomStatus(room)}
          onBack={back}
          right={
            chip === null ? undefined : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Effort ${chip}. Open the dial`}
                onPress={() => { setDialOpen(true); }}
                style={({ pressed }) => ({ minHeight: TAP, flexDirection: "row", alignItems: "center", gap: spacing.xs + 2, paddingHorizontal: spacing.md, borderRadius: TAP / 2, backgroundColor: colors.surfaceRaised, opacity: pressed ? 0.7 : 1 })}
              >
                <Text variant="label" style={{ fontWeight: "600" }}>{chip.split(" · ")[0]}</Text>
                <SymbolView name="chevron.down" size={11} tintColor={colors.textMuted} />
              </Pressable>
            )
          }
        />
      }
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {council !== undefined && (
          <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
            <View style={{ paddingHorizontal: spacing.lg, flexDirection: "row", alignItems: "flex-end", gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <SpendMeter room={room} />
              </View>
              {live && stop}
            </View>
            {control !== null && (
              <View style={{ paddingHorizontal: spacing.lg, gap: spacing.xs, alignItems: "flex-start" }}>
                <Button
                  label={control.label}
                  variant={control.op === "resume" && room.phase === "paused" ? "primary" : "secondary"}
                  height={TAP}
                  disabled={control.busy || runBusy}
                  onPress={() => { running.run(control.op, { op: control.op, roomId: room.id }); }}
                />
                <RequestNote action={running} />
              </View>
            )}
            <PhaseStrip room={room} />
          </View>
        )}
        {council === undefined && room.chat === undefined && live && (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, alignItems: "flex-start" }}>
            {stop}
          </View>
        )}
        {room.chat !== undefined && control !== null && (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.xs, alignItems: "flex-start" }}>
            <Button
              label={control.label}
              variant={control.op === "resume" ? "primary" : "secondary"}
              height={TAP}
              disabled={runBusy}
              onPress={() => { running.run(control.op, { op: control.op, roomId: room.id }); }}
            />
            <RequestNote action={running} />
          </View>
        )}
        <Separator />
        <FlatList
          ref={list}
          data={room.messages}
          keyExtractor={(m) => m.id}
          ItemSeparatorComponent={() => <View style={{ height: spacing.xl }} />}
          contentContainerStyle={{ paddingTop: spacing.lg, paddingBottom: spacing.xl }}
          onContentSizeChange={() => { list.current?.scrollToEnd({ animated: false }); }}
          renderItem={({ item }) => <MessageRow room={room} message={item} actions={actions} decisions={decisions} />}
          ListFooterComponent={
            live && typing.length > 0 ? (
              <Text variant="label" color="textMuted" style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg }}>{typing.join(" · ")}</Text>
            ) : null
          }
        />
        {canPost && (
          <View style={{ borderTopWidth: 1, borderTopColor: colors.hairline, padding: spacing.md, gap: spacing.xs }}>
            <RequestNote action={post} />
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.sm }}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={
                  room.chat !== undefined
                    ? room.phase === "paused"
                      ? "Waits for Resume"
                      : "Message the room, or @mention a member"
                    : room.phase === "paused"
                      ? "Joins the next round once it resumes"
                      : "Say something to the room"
                }
                placeholderTextColor={colors.textFaint}
                multiline
                keyboardAppearance={scheme}
                selectionColor={colors.accent}
                accessibilityLabel="Message the room"
                style={{ flex: 1, minHeight: TAP, maxHeight: 120, paddingHorizontal: spacing.md, paddingTop: 12, paddingBottom: 12, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.surface, color: colors.text, fontSize: 16, lineHeight: 20 }}
              />
              <IconButton symbol="arrow.up" size={TAP} tintColor={colors.bg} backgroundColor={colors.accent} accessibilityLabel="Send" disabled={post.busy !== null || post.unconfirmed !== null || text.trim() === ""} onPress={send} />
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
      {council !== undefined && (
        <DialSheet
          visible={dialOpen}
          onClose={() => { setDialOpen(false); }}
          effort={council.effort}
          routing={routingOf(council)}
          seats={seatsOfRoom(room).length > 0 ? seatsOfRoom(room) : undefined}
          parts={council.parts.length > 0 ? council.parts : castOfRoom(council).parts}
          raise={
            live
              ? {
                  busy: raising.busy !== null,
                  error: raising.error ?? (raising.unconfirmed === null ? null : `${NOT_CONFIRMED} Tap to try again.`),
                  onRaise: () => {
                    if (raising.unconfirmed === null) raising.run("raise", { op: "raise", roomId: room.id });
                    else raising.retry();
                  },
                }
              : undefined
          }
        />
      )}
    </Screen>
  );
}
