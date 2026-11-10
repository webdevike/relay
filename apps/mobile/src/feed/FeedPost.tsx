import { memo } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import type { FeedAction, FeedItem } from "@relay/protocol";
import { IconButton } from "@/ui/IconButton";
import { ImageFrame } from "@/ui/ImageFrame";
import { Text } from "@/ui/Text";
import { relativeTime } from "@/lib/format";
import { feedImageUri } from "@/lib/feed";
import { radii, spacing, useColors } from "@/theme";

/** Photos are 16:10 under the page's side padding. */
const IMAGE_RATIO = 10 / 16;

export interface FeedPostProps {
  item: FeedItem;
  /** What Isaac already did with it: a liked or saved card shows its glyph filled. */
  action: FeedAction | undefined;
  /** `http://host:port` while connected; where a cached thumbnail loads from. */
  hostBase: string | null;
  onAct: (item: FeedItem, action: FeedAction) => void;
  onOpen: (item: FeedItem) => void;
}

/** One card of the feed: source line, picture, title, why it is worth a look, then like, save, skip and open. A flat row on a hairline, not a floating card. */
export const FeedPost = memo(function FeedPost({ item, action, hostBase, onAct, onOpen }: FeedPostProps) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const imageWidth = width - spacing.lg * 2;
  const uri = feedImageUri(item.image, hostBase);
  const meta = [item.source, item.tag, item.process === true ? "process" : null, relativeTime(item.ts)].filter((part) => part !== null && part !== undefined).join(" · ");
  const open = () => {
    onOpen(item);
  };
  return (
    <View style={[styles.post, { borderBottomColor: colors.hairline }]}>
      <Text variant="caption" color="textMuted" numberOfLines={1}>
        {meta}
      </Text>
      {uri !== null && <ImageFrame uri={uri} width={imageWidth} height={imageWidth * IMAGE_RATIO} resizeMode="cover" radius={radii.md} onPress={open} alt={item.title} />}
      <Text variant="title" onPress={open}>
        {item.title}
      </Text>
      {item.why !== "" && (
        <Text variant="body" color="textMuted">
          {item.why}
        </Text>
      )}
      <View style={styles.actions}>
        <IconButton
          symbol={action === "like" ? "heart.fill" : "heart"}
          accessibilityLabel="Like"
          backgroundColor="transparent"
          tintColor={action === "like" ? colors.danger : colors.textMuted}
          size={44}
          glyphSize={20}
          onPress={() => {
            if (action !== "like") onAct(item, "like");
          }}
        />
        <IconButton
          symbol={action === "save" ? "bookmark.fill" : "bookmark"}
          accessibilityLabel="Save"
          backgroundColor="transparent"
          tintColor={action === "save" ? colors.accent : colors.textMuted}
          size={44}
          glyphSize={20}
          onPress={() => {
            if (action !== "save") onAct(item, "save");
          }}
        />
        <IconButton
          symbol="xmark"
          accessibilityLabel="Skip"
          backgroundColor="transparent"
          tintColor={colors.textMuted}
          size={44}
          glyphSize={20}
          onPress={() => {
            onAct(item, "skip");
          }}
        />
        <View style={styles.spacer} />
        <IconButton symbol="arrow.up.right" accessibilityLabel="Open" backgroundColor="transparent" tintColor={colors.textMuted} size={44} glyphSize={20} onPress={open} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  post: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actions: { flexDirection: "row", alignItems: "center", marginLeft: -spacing.md },
  spacer: { flex: 1 },
});
