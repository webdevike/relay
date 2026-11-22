/**
 * Interactive 3D model for the ```ui "model" widget: a 4:3 frame showing a GLB (or self-contained
 * glTF) fitted to the view, one-finger drag to orbit, pinch to zoom, optional turntable spin until
 * touched. Title above, caption below. Loads from the host drop (or an https URL) only when tapped,
 * one model at a time; until then it is a poster (`ui/ModelView`): the drop's name and size over its
 * own poster image when the host has one.
 */
import { useState } from "react";
import { View } from "react-native";
import { spacing } from "@/theme";
import { ImageCaption } from "@/ui/ImageCaption";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { ModelView } from "@/ui/ModelView";
import { Text } from "@/ui/Text";
import { useDropsStore } from "@/state/drops";
import { useDropSrc } from "./dropSrc";
import { failureText } from "./renderReport";
import { useRenderFailure } from "./RenderReportContext";
import { modelEmbedOf } from "./videoEmbed";
import type { ModelSpec } from "./widget";

const ASPECT = 4 / 3;

export function ModelViewer({ spec }: { spec: ModelSpec }) {
  const drops = useDropsStore((s) => s.drops);
  const embed = modelEmbedOf(spec.src, drops);
  const [uri, serverPoster] = useDropSrc([spec.src, embed?.poster ?? ""]);
  const [width, setWidth] = useState(0);
  const height = width / ASPECT;
  const report = useRenderFailure();
  return (
    <View style={{ gap: spacing.sm }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
        }}
      >
        {uri === null || uri === undefined ? (
          <MediaPlaceholder label="Connect to the host to load this model." width={width} height={height} />
        ) : (
          width > 0 && (
            <ModelView
              key={`${spec.src}\n${uri}`}
              uri={uri}
              posterKey={spec.src}
              serverPoster={serverPoster === "" ? null : serverPoster}
              name={embed?.name ?? spec.title ?? "3D model"}
              size={embed?.size}
              width={width}
              height={height}
              autoRotate={spec.autoRotate}
              onError={(message) => {
                report("model", spec.src, failureText("model failed to load", message));
              }}
            />
          )
        )}
      </View>
      <ImageCaption caption={spec.caption} />
    </View>
  );
}
