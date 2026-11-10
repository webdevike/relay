/**
 * New room (`/rooms/new`): the brief, the folder on the Mac to work from, reference images, an
 * optional render command, and the effort dial (a bottom sheet; Team by default). Start sends
 * `rooms.cmd create` and opens the room.
 */
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { COUNCIL_DEFAULT_EFFORT, councilCast, councilChip, councilTime } from "@relay/protocol";
import { roomsRequest } from "@/connection";
import { DialSheet } from "@/rooms/DialSheet";
import { commandError, createCommand, createdRoomId, EMPTY_ROUTING } from "@/rooms/model";
import { Bar, Field, TAP } from "@/rooms/primitives";
import { useRoomsStore } from "@/state/rooms";
import { radii, spacing, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";

export default function NewRoom() {
  const colors = useColors();
  const router = useRouter();
  const supported = useRoomsStore((s) => s.supported);
  const [prompt, setPrompt] = useState("");
  const [source, setSource] = useState("");
  const [refs, setRefs] = useState("");
  const [renderCmd, setRenderCmd] = useState("");
  const [dial, setDial] = useState({ effort: COUNCIL_DEFAULT_EFFORT, routing: EMPTY_ROUTING });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cast = councilCast(dial.effort, dial.routing);

  const start = async (): Promise<void> => {
    const made = createCommand({ prompt, source, refs, renderCmd, effort: dial.effort, routing: dial.routing });
    if (!made.ok) {
      setError(made.error);
      return;
    }
    setError(null);
    setBusy(true);
    const result = await roomsRequest(made.cmd);
    setBusy(false);
    const failed = commandError(result);
    if (failed !== null) {
      setError(failed);
      return;
    }
    const id = createdRoomId(result.ok ? result.value : undefined);
    if (id === null) router.replace("/rooms");
    else router.replace({ pathname: "/rooms/[id]", params: { id } });
  };

  return (
    <Screen
      scroll
      header={<Bar title="New room" onBack={() => { if (router.canGoBack()) router.back(); else router.replace("/rooms"); }} />}
    >
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl, gap: spacing.xl }}>
        <Field label="What should the room make?" value={prompt} onChangeText={setPrompt} lines={4} placeholder="Make the render match the target art." />
        <Field label="Source folder" hint="On your Mac. The room works on a copy and never edits this folder." value={source} onChangeText={setSource} mono placeholder="/Users/ike/Eva/work/..." />
        <Field label="Reference images" hint="One path per line, up to 12." value={refs} onChangeText={setRefs} lines={3} mono />
        <Field label="Render command" hint="Optional. How the room makes a picture of its work." value={renderCmd} onChangeText={setRenderCmd} mono placeholder="Blender -b --python build.py -- --quick" />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Effort ${councilChip(cast)}. Change`}
          onPress={() => { setOpen(true); }}
          style={({ pressed }) => ({ minHeight: 76, flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.lg, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.surface, opacity: pressed ? 0.8 : 1 })}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label" color="textMuted">Effort</Text>
            <Text variant="title">{councilChip(cast)}</Text>
            <Text variant="label" color="textMuted">{`${councilTime(cast.minutes)} · up to ${String(cast.notch.rounds)} ${cast.notch.rounds === 1 ? "round" : "rounds"} · ${String(cast.seats.length)} ${cast.seats.length === 1 ? "seat" : "seats"}`}</Text>
          </View>
          <SymbolView name="slider.horizontal.3" size={22} tintColor={colors.accent} />
        </Pressable>

        {error !== null && <Text variant="body" color="danger">{error}</Text>}
        <Button label="Start room" height={TAP + 8} loading={busy} disabled={supported !== true} onPress={() => void start()} />
      </View>
      <DialSheet visible={open} onClose={() => { setOpen(false); }} effort={dial.effort} routing={dial.routing} onChange={setDial} />
    </Screen>
  );
}
