/** Room images: a tappable thumbnail that opens a full-screen view fetched at a larger size. */
import { useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";
import { radii, spacing, useColors } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { baseName } from "./model";
import { TAP } from "./primitives";
import { useRoomImage } from "./useRoomImage";

/** A square-cropped thumbnail with its caption under it; null `path` shows an empty frame. */
export function RenderThumb({ roomId, path, caption, width, label }: { roomId: string; path: string | undefined; caption?: string | undefined; width: number | "100%"; label?: string | undefined }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const { uri, failed } = useRoomImage(roomId, path, 512);
  const text = caption !== undefined && caption !== "" ? caption : path === undefined ? "" : baseName(path);
  return (
    <View style={{ width, gap: spacing.xs }}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`${label ?? "Render"}: ${text}. Open full screen`}
        disabled={uri === null}
        onPress={() => {
          setOpen(true);
        }}
        style={({ pressed }) => ({ aspectRatio: 1, borderRadius: radii.md, overflow: "hidden", backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.85 : 1, borderWidth: 1, borderColor: colors.hairline })}
      >
        {uri !== null ? (
          <Image source={{ uri }} resizeMode="cover" style={{ width: "100%", height: "100%" }} />
        ) : failed ? (
          <SymbolView name="photo" size={24} tintColor={colors.textFaint} />
        ) : (
          <ActivityIndicator color={colors.textMuted} />
        )}
      </Pressable>
      {text !== "" && (
        <Text variant="label" color="textMuted" numberOfLines={2}>
          {text}
        </Text>
      )}
      {open && path !== undefined && <FullImage roomId={roomId} path={path} caption={text} onClose={() => { setOpen(false); }} />}
    </View>
  );
}

function FullImage({ roomId, path, caption, onClose }: { roomId: string; path: string; caption: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { uri } = useRoomImage(roomId, path, 2048);
  const near = useRoomImage(roomId, path, 512).uri;
  const shown = uri ?? near;
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        {shown === null ? (
          <ActivityIndicator color="#FFFFFF" style={{ flex: 1 }} />
        ) : (
          <Image source={{ uri: shown }} resizeMode="contain" style={{ width, height }} />
        )}
        {uri === null && shown !== null && <ActivityIndicator color="#FFFFFF" style={{ position: "absolute", bottom: insets.bottom + 72, alignSelf: "center" }} />}
        <View style={{ position: "absolute", top: insets.top + spacing.sm, right: spacing.md }}>
          <IconButton symbol="xmark" tone="overlay" size={TAP} glyphSize={16} accessibilityLabel="Close image" onPress={onClose} />
        </View>
        {caption !== "" && (
          <View style={{ position: "absolute", left: spacing.lg, right: spacing.lg, bottom: insets.bottom + spacing.lg }}>
            <Text variant="body" style={{ color: "#FFFFFF", textAlign: "center" }}>{caption}</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
