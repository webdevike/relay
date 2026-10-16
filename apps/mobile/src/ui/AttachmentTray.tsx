import { StyleSheet, View } from "react-native";
import { spacing } from "@/theme";
import { IconButton } from "./IconButton";
import { ImageFrame } from "./ImageFrame";

/** Side of one square thumbnail in the tray. */
export const ATTACHMENT_SIZE = 72;
const REMOVE_SIZE = 22;
/** How far the remove button overhangs the thumbnail's top-right corner. */
const REMOVE_OVERHANG = 6;

export interface AttachmentTrayProps {
  /** Local image URIs waiting to be sent, in order. */
  uris: string[];
  onRemove: (index: number) => void;
}

/**
 * The images queued on a composer: a row of 72pt square thumbnails, each with an x at its top-right
 * corner that removes it. Renders nothing when empty.
 */
export function AttachmentTray({ uris, onRemove }: AttachmentTrayProps) {
  if (uris.length === 0) return null;
  return (
    <View style={styles.row}>
      {uris.map((uri, index) => (
        // The same picture can be attached twice, so position keeps keys unique.
        <View key={`${String(index)}:${uri.slice(-24)}`} style={styles.item}>
          <ImageFrame uri={uri} width={ATTACHMENT_SIZE} height={ATTACHMENT_SIZE} resizeMode="cover" radius={12} alt={`Attachment ${String(index + 1)}`} />
          <View style={styles.remove}>
            <IconButton
              symbol="xmark"
              size={REMOVE_SIZE}
              glyphSize={11}
              backgroundColor="rgba(0,0,0,0.65)"
              tintColor="#FFFFFF"
              accessibilityLabel={`Remove attachment ${String(index + 1)}`}
              onPress={() => {
                onRemove(index);
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.sm, paddingTop: REMOVE_OVERHANG, paddingRight: REMOVE_OVERHANG },
  item: { width: ATTACHMENT_SIZE, height: ATTACHMENT_SIZE },
  remove: { position: "absolute", top: -REMOVE_OVERHANG, right: -REMOVE_OVERHANG },
});
