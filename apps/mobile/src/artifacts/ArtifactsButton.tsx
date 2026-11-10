/**
 * The thread header's Artifacts button: a stack glyph like the buttons beside it, with a blue dot
 * while the thread holds something that arrived since the sheet was last opened there (or an
 * agent's tab Isaac has not opened).
 */
import { View } from "react-native";
import { IconButton } from "@/ui/IconButton";
import { useArtifactsStore } from "@/state/artifacts";
import { useArtifactsSeenStore } from "@/state/artifactsSeen";
import { useColors } from "@/theme";
import { hasNewArtifacts } from "./format";

export interface ArtifactsButtonProps {
  thread: string;
  size: number;
  onPress: () => void;
}

export function ArtifactsButton({ thread, size, onPress }: ArtifactsButtonProps) {
  const colors = useColors();
  const seenAt = useArtifactsSeenStore((state) => state.seen[thread] ?? null);
  const fresh = useArtifactsStore((state) => {
    const snapshot = state.threads[thread];
    return snapshot !== undefined && hasNewArtifacts(snapshot.items, snapshot.tabs, seenAt);
  });
  return (
    <View>
      <IconButton symbol="square.stack.3d.up" size={size} glyphSize={19} backgroundColor="transparent" accessibilityLabel={fresh ? "Artifacts, new items" : "Artifacts"} onPress={onPress} />
      {fresh && <View pointerEvents="none" style={{ position: "absolute", top: 5, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} />}
    </View>
  );
}
