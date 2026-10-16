import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { AgentImageRef } from "@relay/protocol";
import { ImageFrame } from "@/ui/ImageFrame";
import { spacing, useColors } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { requestAgentImage } from "@/connection";

/** A stacked image never exceeds this box; one without known dimensions gets a square of `SQUARE`. */
const MAX_WIDTH = 260;
const MAX_HEIGHT = 320;
const SQUARE = 180;
const RADIUS = 16;

/** One image to show: bytes already on the phone (`uri`) or a host ref whose bytes are fetched. */
interface StackImage {
  key: string;
  /** undefined while the bytes load, null when the host no longer has them. */
  uri: string | null | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export interface MessageImageStackProps {
  /** The omp session the thread runs in; the bytes of `refs` are fetched against it. */
  sessionId: string | null;
  /** Host refs of a message's images. Ignored when `local` is given. */
  refs?: AgentImageRef[] | undefined;
  /** Images still on the phone (a sent turn the host has not listed yet), shown without a fetch. */
  local?: { uri: string; width: number; height: number }[] | undefined;
  align: "flex-start" | "flex-end";
  opacity?: number;
  /** Tapped image: the loaded uris of this stack and the index of the one tapped among them. */
  onOpen: (uris: string[], index: number) => void;
}

function fit(width: number | undefined, height: number | undefined): { width: number; height: number } {
  if (width === undefined || height === undefined) return { width: SQUARE, height: SQUARE };
  const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * A message's images as rounded frames stacked above its text, tap to open. Ref bytes are fetched
 * on first sight (once per ref, see `requestAgentImage`) and land in `useAgentsStore().images`;
 * until then a raised placeholder holds the spot, and a `null` answer (the host no longer has the
 * image) shows a photo glyph.
 */
export function MessageImageStack({ sessionId, refs, local, align, opacity = 1, onOpen }: MessageImageStackProps) {
  const colors = useColors();
  const fetched = useAgentsStore((state) => (sessionId === null ? undefined : state.images[sessionId]));
  useEffect(() => {
    if (local !== undefined || sessionId === null || refs === undefined) return;
    for (const ref of refs) {
      if (fetched?.[ref.id] === undefined) requestAgentImage(sessionId, ref.id);
    }
  }, [local, sessionId, refs, fetched]);

  // Ref ids are content hashes, so the same picture attached twice repeats an id; position keeps keys unique.
  const items: StackImage[] =
    local !== undefined
      ? local.map((image, index) => ({ key: `${String(index)}:local`, uri: image.uri, width: image.width, height: image.height }))
      : (refs ?? []).map((ref, index) => ({ key: `${String(index)}:${ref.id}`, uri: fetched?.[ref.id], width: ref.width, height: ref.height }));
  if (items.length === 0) return null;
  const loaded = items.flatMap((item) => (typeof item.uri === "string" ? [item.uri] : []));

  return (
    <View style={[styles.stack, { alignItems: align, opacity }]}>
      {items.map((item) => {
        const size = fit(item.width, item.height);
        const { uri } = item;
        if (typeof uri !== "string") {
          return (
            <View key={item.key} style={[size, styles.placeholder, { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline }]}>
              {uri === null && <SymbolView name="photo" size={28} tintColor={colors.textFaint} />}
            </View>
          );
        }
        return (
          <ImageFrame
            key={item.key}
            uri={uri}
            width={size.width}
            height={size.height}
            resizeMode="cover"
            radius={RADIUS}
            onPress={() => {
              onOpen(loaded, loaded.indexOf(uri));
            }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.xs },
  placeholder: { borderRadius: RADIUS, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
});
