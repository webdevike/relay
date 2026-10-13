/**
 * The ```ui "image" widget: one framed image at its own shape (or the spec's `aspect`), tap to
 * open the full-screen viewer with pinch zoom, caption and source link underneath.
 */
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { spacing } from "@/theme";
import { ImageCaption } from "@/ui/ImageCaption";
import { ImageFrame } from "@/ui/ImageFrame";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { useDropSrc } from "./dropSrc";
import { ImageViewer } from "./ImageViewer";
import type { ImageSpec } from "./widget";

/** Frame shape until the image reports its own, or when it never does. */
const FALLBACK_ASPECT = 4 / 3;
/** The image's own shape is held to the same range the spec allows, so a sliver can't take over the transcript. */
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;

export function ImageBlock({ spec }: { spec: ImageSpec }) {
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  const [natural, setNatural] = useState<number | null>(null);
  const uri = useDropSrc(spec.src);

  useEffect(() => {
    if (spec.aspect !== undefined || uri === null) return;
    let live = true;
    Image.getSize(
      uri,
      (w, h) => {
        if (live && w > 0 && h > 0) setNatural(Math.min(Math.max(w / h, MIN_ASPECT), MAX_ASPECT));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [spec.aspect, uri]);

  const height = width / (spec.aspect ?? natural ?? FALLBACK_ASPECT);

  return (
    <View style={{ gap: spacing.sm }}>
      <View
        onLayout={(event) => {
          setWidth(event.nativeEvent.layout.width);
        }}
      >
        {width > 0 &&
          (uri === null ? (
            <MediaPlaceholder
              label="Connect to the host to load this image."
              width={width}
              height={height}
            />
          ) : (
            <ImageFrame
              uri={uri}
              width={width}
              height={height}
              alt={spec.alt}
              badge="arrow.up.left.and.arrow.down.right"
              onPress={() => {
                setOpen(true);
              }}
            />
          ))}
      </View>
      <ImageCaption caption={spec.caption} url={spec.url} />
      <ImageViewer
        images={open && uri !== null ? [{ uri, caption: spec.caption, url: spec.url }] : null}
        onClose={() => {
          setOpen(false);
        }}
      />
    </View>
  );
}
