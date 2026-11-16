import { useEffect } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkNotice } from "@/state/linkNotice";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { Toast } from "@/ui/Toast";
import { spacing } from "@/theme";

/** Root-level toast for a `relay://` link that opened the nearest screen (`state/linkNotice.ts`). */
export function LinkNotice() {
  const { notice, seq } = useLinkNotice();
  const { message, show } = useTransientMessage(3500);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (notice !== null) show(notice);
  }, [notice, seq, show]);
  if (message === null) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: spacing.lg,
        right: spacing.lg,
        bottom: insets.bottom + spacing.xl,
      }}
    >
      <Toast message={message} />
    </View>
  );
}
