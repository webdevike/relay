/** Studio's one toast (`useStudioToast`), pinned over the bottom of the grid or the editor; an action (Undo, Open) closes it. */
import { View } from "react-native";
import { ActionToast } from "@/ui/ActionToast";
import { Toast } from "@/ui/Toast";
import { useStudioToast } from "./actions";

export function ToastHost({ bottom }: { bottom: number }) {
  const toast = useStudioToast((state) => state.toast);
  if (toast === null) return null;
  const { action } = toast;
  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom }} pointerEvents="box-none">
      {action === undefined ? (
        <Toast message={toast.text} />
      ) : (
        <ActionToast
          message={toast.text}
          action={action.label}
          onAction={() => {
            useStudioToast.getState().clear();
            action.run();
          }}
        />
      )}
    </View>
  );
}
