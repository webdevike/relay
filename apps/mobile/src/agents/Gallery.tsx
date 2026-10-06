/**
 * Image carousel for the ```ui "gallery" widget: one image per page, swipe or tap the chevrons to
 * step through, title and caption under each. Tapping an image opens the full-screen viewer at that
 * page, where Isaac keeps swiping and can pinch or double tap to zoom.
 */
import { useState } from "react";
import { View } from "react-native";
import { spacing } from "@/theme";
import { ImageCaption } from "@/ui/ImageCaption";
import { ImageFrame } from "@/ui/ImageFrame";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { PageDots, PageStepper } from "@/ui/PageControls";
import { Pager, usePager } from "@/ui/Pager";
import { Text } from "@/ui/Text";
import { resolveDropSrc } from "./dropSrc";
import { ImageViewer, type ViewerImage } from "./ImageViewer";
import type { GallerySpec } from "./widget";

/** Frame shape for every page, so pages line up and the carousel never jumps height. */
const ASPECT = 4 / 3;

export function Gallery({ spec }: { spec: GallerySpec }) {
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const count = spec.images.length;
  const { page, setPage, go } = usePager(count);
  const height = width / ASPECT;

  // Drop paths resolve only while connected to the host; null renders a placeholder.
  const uris = spec.images.map((image) => resolveDropSrc(image.src));
  const viewerImages = spec.images.flatMap((image, i): ViewerImage[] => {
    const uri = uris[i];
    return uri === null || uri === undefined ? [] : [{ ...image, uri }];
  });

  // The viewer only holds loadable images, so its index skips any unresolved ones before `i`.
  const openAt = (i: number) => {
    const before = uris.slice(0, i).filter((u) => u !== null).length;
    setOpen(before);
  };

  const current = spec.images[page];

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
          {spec.title ?? "Images"}
        </Text>
        <PageStepper page={page} count={count} onChange={go} />
      </View>
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
        }}
      >
        <Pager width={width} page={page} onPageChange={setPage}>
          {spec.images.map((image, i) => {
            const uri = uris[i];
            return uri === null || uri === undefined ? (
              <MediaPlaceholder
                key={`${image.src}-${i}`}
                label="Connect to the host to load this image."
                width={width}
                height={height}
              />
            ) : (
              <ImageFrame
                key={`${image.src}-${i}`}
                uri={uri}
                width={width}
                height={height}
                badge="arrow.up.left.and.arrow.down.right"
                onPress={() => {
                  openAt(i);
                }}
              />
            );
          })}
        </Pager>
      </View>
      {current !== undefined && (
        <ImageCaption title={current.title} caption={current.caption} url={current.url} />
      )}
      <PageDots page={page} count={count} />
      <ImageViewer
        images={open === null ? null : viewerImages}
        start={open ?? 0}
        onClose={() => {
          setOpen(null);
        }}
      />
    </View>
  );
}
