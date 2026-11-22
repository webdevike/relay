import { useMachine } from "@xstate/react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { SymbolView } from "expo-symbols";
import { ActivityIndicator, Dimensions, Image, Keyboard, Pressable, RootTagContext, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fromPromise } from "xstate";
import { formatBytes, modelTooLargeText } from "@evaos/chat-core/model-limit";
import { POSTER_MIN_SHARE, settling, useLiveModel, viewportBand, visibility, type Rect } from "@/lib/liveModel";
import { capturePoster, usePoster } from "@/lib/modelPosters";
import { openMediaActions } from "@/media/actions";
import { radii, spacing, useColors } from "@/theme";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { OverlayTag } from "@/ui/OverlayTag";
import { Text } from "@/ui/Text";
import { contentCovered, useScreenFocused } from "@/ui/covering";
import { Holdable } from "./Holdable";
import { modelViewMachine } from "./modelView.machine";
import { NativeModelView } from "../../modules/model-view";

/** A view that cannot say where it is within this long counts as off screen for that settle, ms. */
const MEASURE_TIMEOUT_MS = 250;
/** A size probe (HEAD) that takes longer than this gives up, ms. */
const PROBE_TIMEOUT_MS = 8000;

export interface ModelViewProps {
  /** http(s) URL of a GLB (or a glTF with embedded buffers and images). */
  uri: string;
  /** What the poster is cached under: the model's `src` as the agent wrote it (a drop path survives a host address change). */
  posterKey: string;
  /** The drop's own poster image URL, when the host has one. */
  serverPoster?: string | null | undefined;
  /** What the poster calls it: the drop's file name or the block's title. */
  name: string;
  /** The file's size in bytes when known up front (a drop); otherwise a tap asks the server. */
  size?: number | null | undefined;
  width: number;
  height: number;
  /** Turntable spin until the first touch. */
  autoRotate?: boolean | undefined;
  /** The native view could not load the model; gets its message. */
  onError?: ((message: string) => void) | undefined;
}

/** The size the server gives `uri` (a HEAD, nothing downloaded), or null when it does not say. */
async function headSize(uri: string): Promise<number | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => { abort.abort(); }, PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(uri, { method: "HEAD", signal: abort.signal });
    const length = res.ok ? res.headers.get("content-length") : null;
    return length === null ? null : Number(length);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Base 3D element: a rounded, sized frame around the native glTF view, framed to fit. One-finger
 * drag orbits, pinch zooms; dragging on the frame orbits instead of scrolling the page. It starts
 * as a poster (its snapshot from an earlier open, or the drop's own, under the file's name, size
 * and "Tap to view in 3D") and draws nothing native until tapped. Only one model is open in the app
 * (`lib/liveModel.ts`): tapping another, scrolling this one away or covering its screen closes it.
 * A file over the size limit never opens. A spinner shows while the model loads, a corner tag marks
 * it as 3D, and a failed load turns into the media placeholder.
 * Mount with `key` naming both `uri` and `posterKey`: a new model is a new view.
 */
export function ModelView({ uri, posterKey, serverPoster, name, size, width, height, autoRotate, onError }: ModelViewProps) {
  const colors = useColors();
  const frame = useRef<View>(null);
  const rootTag = useContext(RootTagContext);
  const insets = useSafeAreaInsets();
  const focused = useScreenFocused();
  const snapshot = usePoster(posterKey);
  const poster = snapshot.uri ?? serverPoster ?? null;
  const needsPoster = poster === null && !snapshot.tried;

  const locate = useCallback(
    () =>
      new Promise<Rect | null>((resolve) => {
        const node = frame.current;
        if (node === null) {
          resolve(null);
          return;
        }
        const timeout = setTimeout(() => { resolve(null); }, MEASURE_TIMEOUT_MS);
        node.measureInWindow((x, y, w, h) => {
          clearTimeout(timeout);
          resolve({ x, y, width: w, height: h });
        });
      }),
    [],
  );
  const bandNow = viewportBand(Dimensions.get("window"), insets);
  const band = useRef(bandNow);
  band.current = bandNow;
  const measure = useCallback(async () => {
    const rect = await locate();
    return rect === null ? null : visibility(rect, band.current);
  }, [locate]);
  const claim = useRef<() => void>(() => undefined);
  const [machine] = useState(() =>
    modelViewMachine.provide({
      actions: { claim: () => { claim.current(); } },
      actors: {
        probe: fromPromise(() => (size === null || size === undefined ? headSize(uri) : Promise.resolve(size))),
        capture: fromPromise(() =>
          capturePoster({
            key: posterKey,
            rootTag,
            locate,
            // The band leaves room for the resting composer; with the keyboard up, an open composer
            // card or any sheet, menu or popover over the screen, the cut would hold that chrome.
            clear: (rect) => !settling() && !Keyboard.isVisible() && !contentCovered() && visibility(rect, band.current).share >= POSTER_MIN_SHARE,
            windowWidth: Dimensions.get("window").width,
          }),
        ),
      },
    }),
  );
  const [state, send] = useMachine(machine, { input: { needsPoster, size: size ?? null } });
  const failed = state.matches("failed");
  const [failure, setFailure] = useState("");

  const { live, open, rested } = useLiveModel({ measure, failed, focused });
  claim.current = open;
  useEffect(() => {
    if (!live) send({ type: "slot.lost" });
  }, [live, send]);
  useEffect(() => {
    send({ type: "poster.changed", needed: needsPoster });
  }, [needsPoster, send]);
  useEffect(() => {
    if (rested > 0) send({ type: "viewport.rested" });
  }, [rested, send]);

  if (failed) return <MediaPlaceholder label={failure} width={width} height={height} />;
  if (state.matches("tooLarge")) {
    return <MediaPlaceholder label={`${name}\n${modelTooLargeText(state.context.size ?? 0)}`} width={width} height={height} />;
  }

  const drawing = state.matches("live");
  const loading = state.matches({ live: "loading" }) || state.matches("checking") || state.matches("sized");
  const known = state.context.size;
  return (
    <View ref={frame} collapsable={false} style={{ width, height, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surface }}>
      {poster !== null && (!drawing || loading) && (
        <Image source={{ uri: poster }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
      )}
      {drawing && (
        <NativeModelView
          src={uri}
          autoRotate={autoRotate}
          onLoad={() => {
            send({ type: "model.loaded" });
          }}
          onError={(e) => {
            setFailure(e.nativeEvent.message);
            send({ type: "model.failed" });
            onError?.(e.nativeEvent.message);
          }}
          style={{ width, height }}
        />
      )}
      {loading ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : drawing ? (
        // No tag until the poster is taken: the snapshot is cut from the screen and would keep it.
        !needsPoster && <OverlayTag icon="rotate.3d" label="3D" corner="top-left" />
      ) : (
        <Holdable onHold={poster === null ? undefined : () => {
          openMediaActions({ uri: poster, kind: "image" });
        }}>
          <Pressable
            onPress={() => {
              send({ type: "view.open" });
            }}
            accessibilityRole="button"
            accessibilityLabel={`View ${name} in 3D`}
            style={[StyleSheet.absoluteFill, poster !== null ? styles.bottom : styles.center]}
          >
            <View style={[styles.label, poster !== null && { backgroundColor: "rgba(0,0,0,0.6)" }]}>
              {poster === null && <SymbolView name="rotate.3d" size={36} tintColor={colors.textMuted} />}
              <Text variant="label" numberOfLines={1} style={poster !== null ? styles.light : undefined}>
                {name}
              </Text>
              <Text variant="caption" color="textMuted" style={poster !== null ? styles.light : undefined}>
                {known === null ? "Tap to view in 3D" : `${formatBytes(known)} · Tap to view in 3D`}
              </Text>
            </View>
          </Pressable>
        </Holdable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  bottom: { justifyContent: "flex-end" },
  label: { alignItems: "center", gap: spacing.xs, padding: spacing.sm },
  light: { color: "#FFFFFF" },
});
