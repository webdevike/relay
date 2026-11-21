import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMediaNotice } from "@/state/mediaNotice";
import { spacing } from "@/theme";
import { Toast } from "@/ui/Toast";

/** Room under a full-screen viewer's top buttons. */
const VIEWER_TOOLBAR = 64;

/**
 * The media notice (`state/mediaNotice.ts`) as a toast: near the bottom, or in a full-screen
 * `viewer` under its top buttons, where captions and playback controls hold the bottom.
 */
export function MediaNotice({ viewer = false }: { viewer?: boolean }) {
  const notice = useMediaNotice((state) => state.notice);
  const insets = useSafeAreaInsets();
  if (notice === null) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        { position: "absolute", left: spacing.lg, right: spacing.lg },
        viewer ? { top: insets.top + VIEWER_TOOLBAR } : { bottom: insets.bottom + spacing.xl },
      ]}
    >
      <Toast message={notice} />
    </View>
  );
}
