import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton } from "@/ui/IconButton";
import { colors, spacing } from "@/theme";

export interface ImageViewerProps {
  /** Data URI to show; `null` keeps the viewer closed. */
  uri: string | null;
  onClose: () => void;
}

/** A transcript image at full size on black; a tap anywhere or the close button dismisses. */
export function ImageViewer({ uri, onClose }: ImageViewerProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={uri !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {uri !== null && <Image source={{ uri }} resizeMode="contain" style={StyleSheet.absoluteFill} />}
      </Pressable>
      <View style={[styles.close, { top: insets.top + spacing.sm }]}>
        <IconButton symbol="xmark" onPress={onClose} tintColor={colors.text} backgroundColor="rgba(255,255,255,0.12)" />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#000" },
  close: { position: "absolute", right: spacing.lg },
});
