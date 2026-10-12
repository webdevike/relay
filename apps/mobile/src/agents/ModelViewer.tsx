/**
 * Interactive 3D model for the ```ui "model" widget: a 4:3 frame showing a GLB (or self-contained
 * glTF) fitted to the view, one-finger drag to orbit, pinch to zoom, optional turntable spin until
 * touched. Title above, caption below. Loads from the host drop (or an https URL) once connected.
 */
import { useState } from "react";
import { View } from "react-native";
import { spacing } from "@/theme";
import { ImageCaption } from "@/ui/ImageCaption";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { ModelView } from "@/ui/ModelView";
import { Text } from "@/ui/Text";
import { resolveDropSrc } from "./dropSrc";
import type { ModelSpec } from "./widget";

const ASPECT = 4 / 3;

export function ModelViewer({ spec }: { spec: ModelSpec }) {
  const uri = resolveDropSrc(spec.src);
  const [width, setWidth] = useState(0);
  const height = width / ASPECT;
  return (
    <View style={{ gap: spacing.sm }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
        }}
      >
        {uri === null ? (
          <MediaPlaceholder label="Connect to the host to load this model." width={width} height={height} />
        ) : (
          width > 0 && <ModelView uri={uri} width={width} height={height} autoRotate={spec.autoRotate} />
        )}
      </View>
      <ImageCaption caption={spec.caption} />
    </View>
  );
}
