import { useState } from "react";
import { Modal, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { ImageCaption } from "@/ui/ImageCaption";
import { LinkButton } from "@/ui/LinkButton";
import { PageCounter } from "@/ui/PageControls";
import { Pager, usePager } from "@/ui/Pager";
import { ZoomableImage } from "./ZoomableImage";

export interface ViewerImage {
  uri: string;
  title?: string | undefined;
  caption?: string | undefined;
  /** Source page (e.g. the Dribbble shot); shows an open button. */
  url?: string | undefined;
}

export interface ImageViewerProps {
  /** Images to page through; `null` keeps the viewer closed. */
  images: ViewerImage[] | null;
  /** Page shown when the viewer opens. */
  start?: number;
  onClose: () => void;
}

/**
 * Images full-screen on black. Swipe or tap the chevrons to page; pinch to zoom, drag to pan while
 * zoomed, double tap to toggle a 2.5x zoom, single tap (or the close button) to dismiss. Paging
 * stops while an image is zoomed so a pan never flips the page.
 *
 * The gestures live under their own GestureHandlerRootView: a React Native Modal renders in a
 * detached native hierarchy the app-root provider does not reach, so without this the pinch/pan
 * handlers never receive touches.
 */
export function ImageViewer({ images, start = 0, onClose }: ImageViewerProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const count = images?.length ?? 0;
  const { page, setPage, go } = usePager(count, start);
  const [zoomed, setZoomed] = useState(false);

  // Each open starts at `start` at fit; keyed on visibility so a re-render's new array keeps the page.
  // Reset during render, not in an effect: the Pager mounts with `contentOffset` from `page`, so the
  // page must already be `start` on the first open frame or it would animate over from the last one.
  const opening = images === null ? null : start;
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  if (opening !== openedAt) {
    setOpenedAt(opening);
    if (opening !== null) {
      setPage(opening);
      setZoomed(false);
    }
  }

  const step = (next: number) => {
    go(next);
    setZoomed(false);
  };

  const current = images?.[page];

  return (
    <Modal
      visible={images !== null}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={styles.backdrop}>
        {images !== null && (
          <Pager
            width={width}
            page={page}
            onPageChange={setPage}
            scrollEnabled={!zoomed && count > 1}
          >
            {images.map((image, i) => (
              <ZoomableImage
                // Pages away from the current one remount at fit when they come back.
                key={`${image.uri}-${i}-${i === page}`}
                uri={image.uri}
                width={width}
                height={height}
                onTap={onClose}
                onZoomChange={setZoomed}
              />
            ))}
          </Pager>
        )}
        <View style={[styles.top, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
          {count > 1 ? <PageCounter page={page} count={count} tone="overlay" /> : <View />}
          <View style={styles.row} pointerEvents="box-none">
            {current?.url !== undefined && (
              <LinkButton url={current.url} variant="icon" tone="overlay" />
            )}
            <IconButton symbol="xmark" onPress={onClose} tone="overlay" />
          </View>
        </View>
        <View
          style={[styles.bottom, { bottom: insets.bottom + spacing.md }]}
          pointerEvents="box-none"
        >
          {count > 1 && (
            <IconButton
              symbol="chevron.left"
              onPress={() => {
                step(page - 1);
              }}
              tone="overlay"
            />
          )}
          <View style={styles.text} pointerEvents="none">
            {current !== undefined && (
              <ImageCaption title={current.title} caption={current.caption} tone="overlay" />
            )}
          </View>
          {count > 1 && (
            <IconButton
              symbol="chevron.right"
              onPress={() => {
                step(page + 1);
              }}
              tone="overlay"
            />
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#000" },
  top: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  row: { flexDirection: "row", gap: spacing.sm },
  bottom: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
  },
  text: { flex: 1 },
});
