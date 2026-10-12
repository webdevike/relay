import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { radii, useColors } from "@/theme";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { OverlayTag } from "@/ui/OverlayTag";
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
 * into the media placeholder.
 */
export function ModelView({ uri, width, height, autoRotate }: ModelViewProps) {
  const colors = useColors();
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ uri: string; message: string } | null>(null);

  if (failed?.uri === uri) return <MediaPlaceholder label={failed.message} width={width} height={height} />;

  return (
    <View style={{ width, height, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surface }}>
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
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      )}
    </View>
  );
}
