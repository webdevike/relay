/**
 * One room (`/rooms/<id>`). The header carries the title, the effort chip (opens the dial; the only
 * thing it changes is "Raise one notch" while the room runs), the spend meter and the phase strip.
 * Under it the feed: seats' messages with their role, part and model, renders you can open full
 * screen, and the council's cards. Isaac posts from the composer at the bottom; Resolve now ends
 * the room.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { RoomWireMessage } from "@relay/protocol";
import { requestRooms, roomsRequest } from "@/connection";
import { DialSheet } from "@/rooms/DialSheet";
import type { CardActions } from "@/rooms/Cards";
import { MessageRow } from "@/rooms/MessageRow";
import { Bar, TAP } from "@/rooms/primitives";
import { PhaseStrip, SpendMeter } from "@/rooms/Status";
import { castOfRoom, commandError, notchLabel, roomLive, roomStatus, routingOf, seatsOfRoom } from "@/rooms/model";
import { useRoom } from "@/state/rooms";
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialOpen, setDialOpen] = useState(false);
  const [raising, setRaising] = useState(false);
  const [raiseError, setRaiseError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      requestRooms();
    }, []),
  );

  const actions = useMemo<CardActions>(
    () => ({
      budget: async (choice) => commandError(await roomsRequest({ op: "budget", roomId: id, choice })),
      answer: async (askId, allow) => commandError(await roomsRequest({ op: "answer", roomId: id, askId, allow })),
    }),
    [id],
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
  const council = room.council;
  const send = async (): Promise<void> => {
    const body = text.trim();
    if (body === "") return;
    setSending(true);
    setError(null);
    const failed = commandError(await roomsRequest({ op: "post", roomId: room.id, text: body }));
    setSending(false);
    if (failed === null) setText("");
    else setError(failed);
  };
  const raise = async (): Promise<void> => {
    setRaising(true);
    setRaiseError(null);
    setRaiseError(commandError(await roomsRequest({ op: "raise", roomId: room.id })));
    setRaising(false);
  };
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
              {live && <Button label="Resolve now" variant="secondary" height={TAP} onPress={() => void roomsRequest({ op: "stop", roomId: room.id })} />}
            </View>
            <PhaseStrip room={room} />
          </View>
        )}
        {council === undefined && live && (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, alignItems: "flex-start" }}>
            <Button label="Resolve now" variant="secondary" height={TAP} onPress={() => void roomsRequest({ op: "stop", roomId: room.id })} />
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
          renderItem={({ item }) => <MessageRow room={room} message={item} actions={actions} />}
          ListFooterComponent={
            live && typing.length > 0 ? (
              <Text variant="label" color="textMuted" style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg }}>{typing.join(" · ")}</Text>
            ) : null
          }
        />
        {live && (
          <View style={{ borderTopWidth: 1, borderTopColor: colors.hairline, padding: spacing.md, gap: spacing.xs }}>
            {error !== null && <Text variant="label" color="danger">{error}</Text>}
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.sm }}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Say something to the room"
                placeholderTextColor={colors.textFaint}
                multiline
                keyboardAppearance={scheme}
                selectionColor={colors.accent}
                accessibilityLabel="Message the room"
                style={{ flex: 1, minHeight: TAP, maxHeight: 120, paddingHorizontal: spacing.md, paddingTop: 12, paddingBottom: 12, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.surface, color: colors.text, fontSize: 16, lineHeight: 20 }}
              />
              <IconButton symbol="arrow.up" size={TAP} tintColor={colors.bg} backgroundColor={colors.accent} accessibilityLabel="Send" disabled={sending || text.trim() === ""} onPress={() => void send()} />
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
          raise={live ? { busy: raising, error: raiseError, onRaise: () => void raise() } : undefined}
        />
      )}
    </Screen>
  );
}
