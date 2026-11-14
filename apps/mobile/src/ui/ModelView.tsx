import { NavigationContext } from "@react-navigation/native";
import { useMachine } from "@xstate/react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { SymbolView } from "expo-symbols";
import { ActivityIndicator, Dimensions, Image, Pressable, RootTagContext, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fromPromise } from "xstate";
import { POSTER_MIN_SHARE, settling, useLiveModel, viewportBand, visibility, type Rect } from "@/lib/liveModel";
import { capturePoster, usePoster } from "@/lib/modelPosters";
import { radii, spacing, useColors } from "@/theme";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { OverlayTag } from "@/ui/OverlayTag";
import { Text } from "@/ui/Text";
import { modelViewMachine } from "./modelView.machine";
import { NativeModelView } from "../../modules/model-view";

/** A view that cannot say where it is within this long counts as off screen for that settle, ms. */
const MEASURE_TIMEOUT_MS = 250;

export interface ModelViewProps {
  /** http(s) URL of a GLB (or a glTF with embedded buffers and images). */
  uri: string;
  /** What the poster is cached under: the model's `src` as the agent wrote it (a drop path survives a host address change). */
  posterKey: string;
  /** The drop's own poster image URL, when the host has one. */
  serverPoster?: string | null | undefined;
  width: number;
  height: number;
  /** Turntable spin until the first touch. */
  autoRotate?: boolean | undefined;
  /** The native view could not load the model; gets its message. */
  onError?: ((message: string) => void) | undefined;
}

/** Whether the screen holding this view is the focused one; true outside a navigator. */
function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
  useEffect(() => {
    if (navigation === undefined) return;
    setFocused(navigation.isFocused());
    const offFocus = navigation.addListener("focus", () => { setFocused(true); });
    const offBlur = navigation.addListener("blur", () => { setFocused(false); });
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);
  return focused;
}

/**
 * Base 3D element: a rounded, sized frame around the native glTF view, framed to fit. One-finger
 * drag orbits, pinch zooms; dragging on the frame orbits instead of scrolling the page. Only the
 * views holding the app-wide slot (`lib/liveModel.ts`: the most visible model, plus one making a
 * poster) draw the native view; every other one shows its poster (a snapshot of it from when it
 * was live, or the drop's own), and a tap makes it live. A spinner shows while the model loads,
 * a corner tag marks it as 3D, and a failed load turns into the media placeholder.
 * Mount with `key` naming both `uri` and `posterKey`: a new model is a new view.
 */
export function ModelView({ uri, posterKey, serverPoster, width, height, autoRotate, onError }: ModelViewProps) {
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
  const [machine] = useState(() =>
    modelViewMachine.provide({
      actors: {
        capture: fromPromise(() =>
          capturePoster({
            key: posterKey,
            rootTag,
            locate,
            clear: (rect) => !settling() && visibility(rect, band.current).share >= POSTER_MIN_SHARE,
            windowWidth: Dimensions.get("window").width,
          }),
        ),
      },
    }),
  );
  const [state, send] = useMachine(machine, { input: { needsPoster } });
  const failed = state.matches("failed");
  const [failure, setFailure] = useState("");

  const { live, activate, rested } = useLiveModel({ measure, poster: !needsPoster, failed, focused });
  useEffect(() => {
    send({ type: live ? "slot.gained" : "slot.lost" });
  }, [live, send]);
  useEffect(() => {
    send({ type: "poster.changed", needed: needsPoster });
  }, [needsPoster, send]);
  useEffect(() => {
    if (rested > 0) send({ type: "viewport.rested" });
  }, [rested, send]);

  if (failed) return <MediaPlaceholder label={failure} width={width} height={height} />;

  const drawing = state.matches("live");
  const loading = state.matches({ live: "loading" });
  return (
    <View ref={frame} collapsable={false} style={{ width, height, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surface }}>
      {poster !== null && (!drawing || loading) && (
        <Image source={{ uri: poster }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
      )}
      {drawing ? (
        <>
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
          {loading ? (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
              <ActivityIndicator color={colors.textMuted} />
            </View>
          ) : (
            // No tag until the poster is taken: the snapshot is cut from the screen and would keep it.
            !needsPoster && <OverlayTag icon="rotate.3d" label="3D" corner="top-left" />
          )}
        </>
      ) : (
        <Pressable onPress={activate} accessibilityRole="button" accessibilityLabel="View in 3D" style={[StyleSheet.absoluteFill, styles.center, styles.gap]}>
          {poster !== null ? (
            <OverlayTag icon="rotate.3d" label="3D" corner="top-left" />
          ) : (
            <>
              <SymbolView name="rotate.3d" size={36} tintColor={colors.textMuted} />
              <Text variant="caption" color="textMuted">
                3D model
              </Text>
            </>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  gap: { gap: spacing.sm },
});
