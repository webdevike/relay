/**
 * The ```ui "diagram" widget: a diagram rendered to an image on the host (diagram-design page or
 * mermaid chart), shown whole at its own aspect ratio. Tapping opens the full-screen viewer, where
 * pinch and double tap zoom into the detail a phone-width frame can't show.
 */
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { spacing } from "@/theme";
import { ImageCaption } from "@/ui/ImageCaption";
import { ImageFrame } from "@/ui/ImageFrame";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { Text } from "@/ui/Text";
import { useDropSrc } from "./dropSrc";
import { ImageViewer } from "./ImageViewer";
import type { DiagramSpec } from "./widget";

/** Frame shape until the image reports its size. */
const FALLBACK_ASPECT = 4 / 3;
/** Tall diagrams stop growing at this height-to-width ratio and fit inside instead. */
const MAX_HEIGHT_RATIO = 1.5;

export function DiagramView({ spec }: { spec: DiagramSpec }) {
  const uri = useDropSrc(spec.src);
  const [width, setWidth] = useState(0);
  const [aspect, setAspect] = useState(FALLBACK_ASPECT);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (uri === null) return;
    Image.getSize(uri, (w, h) => {
      if (w > 0 && h > 0) setAspect(w / h);
    });
  }, [uri]);

  const height = Math.min(width / aspect, width * MAX_HEIGHT_RATIO);

  return (
    <View style={{ gap: spacing.sm }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
        }}
      >
        {uri === null ? (
          <MediaPlaceholder label="Connect to the host to load this diagram." width={width} height={width / FALLBACK_ASPECT} />
        ) : (
          width > 0 && (
            <ImageFrame
              uri={uri}
              width={width}
              height={height}
              badge="arrow.up.left.and.arrow.down.right"
              onPress={() => {
                setOpen(true);
              }}
            />
          )
        )}
      </View>
      <ImageCaption caption={spec.caption} url={spec.url} />
      <ImageViewer
        images={open && uri !== null ? [{ uri, title: spec.title, caption: spec.caption, url: spec.url }] : null}
        onClose={() => {
          setOpen(false);
        }}
      />
    </View>
  );
}
