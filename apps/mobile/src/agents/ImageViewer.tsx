import { useEffect, useRef, useState } from "react";
import { Linking, Modal, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tapHaptic } from "@/lib/haptics";
import { spacing, tabularNumbers } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
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
  const scroller = useRef<ScrollView>(null);
  const [page, setPage] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const count = images?.length ?? 0;

  // Each open starts at `start` at fit; keyed on visibility so a re-render's new array keeps the page.
  const visible = images !== null;
  useEffect(() => {
    if (!visible) return;
    setPage(start);
    setZoomed(false);
  }, [visible, start]);

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(count - 1, next));
    if (clamped === page) return;
    tapHaptic();
    setPage(clamped);
    setZoomed(false);
    scroller.current?.scrollTo({ x: clamped * width, animated: true });
  };

  const current = images?.[page];
  const openSource = (url: string) => {
    void Linking.openURL(url);
  };

  return (
    <Modal
      visible={images !== null}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={styles.backdrop}>
        {images !== null && (
          <ScrollView
            ref={scroller}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomed && count > 1}
            showsHorizontalScrollIndicator={false}
            contentOffset={{ x: start * width, y: 0 }}
            onMomentumScrollEnd={(e) => {
              setPage(Math.round(e.nativeEvent.contentOffset.x / width));
            }}
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
          </ScrollView>
        )}
        <View style={[styles.top, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
          {/* The backdrop is black in either scheme, so the glyphs stay white. */}
          {count > 1 ? (
            <Text variant="label" style={[styles.white, tabularNumbers]}>
              {page + 1} / {count}
            </Text>
          ) : (
            <View />
          )}
          <View style={styles.row} pointerEvents="box-none">
            {current?.url !== undefined && (
              <IconButton
                symbol="safari"
                onPress={() => {
                  if (current.url !== undefined) openSource(current.url);
                }}
                tintColor="#FFFFFF"
                backgroundColor={GLASS}
              />
            )}
            <IconButton
              symbol="xmark"
              onPress={onClose}
              tintColor="#FFFFFF"
              backgroundColor={GLASS}
            />
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
                go(page - 1);
              }}
              tintColor="#FFFFFF"
              backgroundColor={GLASS}
            />
          )}
          <View style={styles.text} pointerEvents="none">
            {current !== undefined &&
              (current.title !== undefined || current.caption !== undefined) && (
                <View style={styles.plate}>
                  {current.title !== undefined && (
                    <Text variant="label" style={styles.white} numberOfLines={2}>
                      {current.title}
                    </Text>
                  )}
                  {current.caption !== undefined && (
                    <Text variant="caption" style={styles.dim} numberOfLines={3}>
                      {current.caption}
                    </Text>
                  )}
                </View>
              )}
          </View>
          {count > 1 && (
            <IconButton
              symbol="chevron.right"
              onPress={() => {
                go(page + 1);
              }}
              tintColor="#FFFFFF"
              backgroundColor={GLASS}
            />
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const GLASS = "rgba(255,255,255,0.12)";

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
  plate: {
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: 2,
  },
  white: { color: "#FFFFFF" },
  dim: { color: "rgba(255,255,255,0.75)" },
});
