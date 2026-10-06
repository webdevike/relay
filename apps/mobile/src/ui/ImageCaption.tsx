import { View } from "react-native";

import { spacing } from "@/theme";
import { LinkButton } from "@/ui/LinkButton";
import { Text } from "@/ui/Text";

export interface ImageCaptionProps {
  title?: string | undefined;
  caption?: string | undefined;
  url?: string | undefined;
  tone?: "default" | "overlay" | undefined;
}

/** Title/caption block for an image: inline row with link in chat, or a dark plate over the viewer. */
export function ImageCaption({ title, caption, url, tone }: ImageCaptionProps) {
  const overlay = tone === "overlay";
  if (title === undefined && caption === undefined && (overlay || url === undefined)) return null;

  if (overlay) {
    return (
      <View
        pointerEvents="none"
        style={{
          backgroundColor: "rgba(0,0,0,0.6)",
          borderRadius: 10,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          gap: 2,
        }}
      >
        {title !== undefined ? (
          <Text variant="label" numberOfLines={2} style={{ color: "#FFFFFF" }}>
            {title}
          </Text>
        ) : null}
        {caption !== undefined ? (
          <Text variant="caption" numberOfLines={3} style={{ color: "rgba(255,255,255,0.75)" }}>
            {caption}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
      <View style={{ flex: 1, gap: 2 }}>
        {title !== undefined ? (
          <Text variant="body" numberOfLines={2}>
            {title}
          </Text>
        ) : null}
        {caption !== undefined ? (
          <Text variant="caption" color="textMuted" numberOfLines={3}>
            {caption}
          </Text>
        ) : null}
      </View>
      {url !== undefined ? <LinkButton url={url} variant="icon" /> : null}
    </View>
  );
}
