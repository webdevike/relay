/** Picks an image already on the host (an output or an upload) for a keyframe or reference slot. */
import { View } from "react-native";
import type { StudioAsset } from "@relay/protocol";
import { spacing } from "@/theme";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { ThumbGrid } from "@/ui/ThumbGrid";

export interface GallerySheetProps {
  visible: boolean;
  title: string;
  /** Images to choose from, newest first. */
  images: readonly StudioAsset[];
  base: string | null;
  onPick: (asset: StudioAsset) => void;
  onClose: () => void;
}

export function GallerySheet({ visible, title, images, base, onPick, onClose }: GallerySheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ gap: spacing.md, paddingTop: spacing.sm }}>
        <Text variant="title">{title}</Text>
        {images.length === 0 ? (
          <Text variant="body" color="textMuted">
            No images yet. Upload one from the phone instead.
          </Text>
        ) : (
          <ThumbGrid
            items={images.map((asset) => ({ key: asset.id, uri: base === null ? null : `${base}${asset.thumb}`, accessibilityLabel: asset.origin === "upload" ? "Uploaded image" : "Generated image" }))}
            onPress={(key) => {
              const asset = images.find((image) => image.id === key);
              if (asset !== undefined) onPick(asset);
            }}
          />
        )}
      </View>
    </Sheet>
  );
}
