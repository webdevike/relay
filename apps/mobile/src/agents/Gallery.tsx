/**
 * Image carousel for the ```ui "gallery" widget: one image per page, swipe or tap the chevrons to
 * step through, title and caption under each. Tapping an image opens the full-screen viewer at that
 * page, where Isaac keeps swiping and can pinch or double tap to zoom.
 */
import { useRef, useState } from "react";
import { Image, Linking, Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { tapHaptic } from "@/lib/haptics";
import { radii, spacing, tabularNumbers, useColors } from "@/theme";
import { Text } from "@/ui/Text";
import { resolveDropSrc } from "./dropSrc";
import { ImageViewer, type ViewerImage } from "./ImageViewer";
import type { GallerySpec } from "./widget";

/** Frame shape for every page, so pages line up and the carousel never jumps height. */
const ASPECT = 4 / 3;
/** Past this many images the dots row gets too long to read; the counter carries position. */
const MAX_DOTS = 20;

export function Gallery({ spec }: { spec: GallerySpec }) {
  const colors = useColors();
  const scroller = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const count = spec.images.length;
  const height = width / ASPECT;

  // Drop paths resolve only while connected to the host; null renders a placeholder.
  const uris = spec.images.map((image) => resolveDropSrc(image.src));
  const viewerImages = spec.images.flatMap((image, i): ViewerImage[] => {
    const uri = uris[i];
    return uri === null || uri === undefined ? [] : [{ ...image, uri }];
  });
  const openSource = (url: string) => {
    void Linking.openURL(url);
  };

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(count - 1, next));
    if (clamped === page) return;
    tapHaptic();
    setPage(clamped);
    scroller.current?.scrollTo({ x: clamped * width, animated: true });
  };

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
        {count > 1 && (
          <>
            <Chevron
              symbol="chevron.left"
              disabled={page === 0}
              onPress={() => {
                go(page - 1);
              }}
            />
            <Text variant="caption" color="textMuted" style={tabularNumbers}>
              {page + 1} / {count}
            </Text>
            <Chevron
              symbol="chevron.right"
              disabled={page === count - 1}
              onPress={() => {
                go(page + 1);
              }}
            />
          </>
        )}
      </View>
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
        }}
      >
        {width > 0 && (
          <ScrollView
            ref={scroller}
            horizontal
            pagingEnabled
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              setPage(Math.round(e.nativeEvent.contentOffset.x / width));
            }}
          >
            {spec.images.map((image, i) => {
              const uri = uris[i];
              const frame = {
                width,
                height,
                borderRadius: radii.sm,
                overflow: "hidden" as const,
                backgroundColor: colors.surface,
              };
              return (
                <View key={`${image.src}-${i}`} style={{ width }}>
                  {uri === null || uri === undefined ? (
                    <View
                      style={[
                        frame,
                        { alignItems: "center", justifyContent: "center", padding: spacing.md },
                      ]}
                    >
                      <Text variant="caption" color="textMuted">
                        Connect to the host to load this image.
                      </Text>
                    </View>
                  ) : (
                    <Pressable
                      onPress={() => {
                        openAt(i);
                      }}
                      style={({ pressed }) => [frame, { opacity: pressed ? 0.85 : 1 }]}
                    >
                      <Image source={{ uri }} resizeMode="contain" style={{ width, height }} />
                      <View
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          right: spacing.xs,
                          bottom: spacing.xs,
                          padding: 6,
                          borderRadius: radii.sm,
                          backgroundColor: "rgba(0,0,0,0.55)",
                        }}
                      >
                        <SymbolView
                          name="arrow.up.left.and.arrow.down.right"
                          size={12}
                          tintColor="#FFFFFF"
                        />
                      </View>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>
      {current !== undefined &&
        (current.title !== undefined ||
          current.caption !== undefined ||
          current.url !== undefined) && (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
            <View style={{ flex: 1, gap: 2 }}>
              {current.title !== undefined && (
                <Text variant="body" numberOfLines={2}>
                  {current.title}
                </Text>
              )}
              {current.caption !== undefined && (
                <Text variant="caption" color="textMuted" numberOfLines={3}>
                  {current.caption}
                </Text>
              )}
            </View>
            {current.url !== undefined && (
              <Pressable
                hitSlop={10}
                onPress={() => {
                  if (current.url !== undefined) openSource(current.url);
                }}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingTop: 2 })}
              >
                <SymbolView name="arrow.up.right.square" size={18} tintColor={colors.accent} />
              </Pressable>
            )}
          </View>
        )}
      {count > 1 && count <= MAX_DOTS && (
        <View style={{ flexDirection: "row", justifyContent: "center", gap: spacing.xs }}>
          {spec.images.map((image, i) => (
            <View
              key={`${image.src}-${i}`}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === page ? colors.accent : colors.hairline,
              }}
            />
          ))}
        </View>
      )}
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

function Chevron({
  symbol,
  disabled,
  onPress,
}: {
  symbol: "chevron.left" | "chevron.right";
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      hitSlop={10}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.3 : pressed ? 0.6 : 1 })}
    >
      <SymbolView name={symbol} size={14} tintColor={colors.textMuted} />
    </Pressable>
  );
}
