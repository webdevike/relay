import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useLiveModel } from "@/lib/liveModel";
import { radii, spacing, useColors } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { OverlayTag } from "@/ui/OverlayTag";
import { Text } from "@/ui/Text";
import { NativeModelView } from "../../modules/model-view";

export interface ModelViewProps {
  /** http(s) URL of a GLB (or a glTF with embedded buffers and images). */
  uri: string;
  width: number;
  height: number;
  /** Turntable spin until the first touch. */
  autoRotate?: boolean | undefined;
}

/**
 * Base 3D element: a rounded, sized frame around the native glTF view, framed to fit. One-finger
 * drag orbits, pinch zooms; dragging on the frame orbits instead of scrolling the page. A spinner
 * shows while the model downloads, a corner tag marks it as interactive, and a failed load turns
 * into the media placeholder. Only one native view is live in the app, and only a model the app has
 * not shown before loads on its own (`lib/liveModel.ts`): every other one shows a "View in 3D" card,
 * and tapping it moves the live view there.
 */
export function ModelView({ uri, width, height, autoRotate }: ModelViewProps) {
  const colors = useColors();
  const { live, activate } = useLiveModel(uri);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ uri: string; message: string } | null>(null);
  // A view that lost the slot reloads its model when it gets it back, so its spinner shows again.
  if (!live && loaded !== null) setLoaded(null);

  if (failed?.uri === uri) return <MediaPlaceholder label={failed.message} width={width} height={height} />;

  return (
    <View style={{ width, height, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surface }}>
      {live ? (
        <>
          <NativeModelView
            src={uri}
            autoRotate={autoRotate}
            onLoad={() => {
              setLoaded(uri);
            }}
            onError={(e) => {
              setFailed({ uri, message: e.nativeEvent.message });
            }}
            style={{ width, height }}
          />
          {loaded === uri ? (
            <OverlayTag icon="rotate.3d" label="3D" corner="top-left" />
          ) : (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
              <ActivityIndicator color={colors.textMuted} />
            </View>
          )}
        </>
      ) : (
        <Pressable onPress={activate} accessibilityRole="button" accessibilityLabel="View in 3D" style={[StyleSheet.absoluteFill, styles.center, styles.gap]}>
          <IconButton symbol="rotate.3d" size={52} onPress={activate} accessibilityLabel="View in 3D" />
          <Text variant="caption" color="textMuted">
            View in 3D
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  gap: { gap: spacing.sm },
});
