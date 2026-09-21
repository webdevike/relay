/**
 * Bottom sheet on @gorhom/bottom-sheet: presents when `visible` turns on (or on mount), sizes to
 * its content, dims the screen, closes on backdrop tap or a drag down, and reports every close
 * through `onClose`. Content that scrolls or takes text input inside should use the
 * `BottomSheetScrollView` / `BottomSheetTextInput` re-exports so gestures and the keyboard cooperate.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { colors, radii, spacing } from "@/theme";

export {
  BottomSheetScrollView as SheetScrollView,
  BottomSheetTextInput as SheetTextInput,
} from "@gorhom/bottom-sheet";

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

function Backdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0.5}
      pressBehavior="close"
    />
  );
}

export function Sheet({ visible, onClose, children }: SheetProps) {
  const ref = useRef<BottomSheetModal>(null);
  useEffect(() => {
    if (visible) ref.current?.present();
    else ref.current?.dismiss();
  }, [visible]);
  const dismissed = useCallback(() => {
    if (visible) onClose();
  }, [visible, onClose]);

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      onDismiss={dismissed}
      backdropComponent={Backdrop}
      backgroundStyle={{ backgroundColor: colors.surface, borderRadius: radii.lg }}
      handleIndicatorStyle={{ backgroundColor: colors.hairline, width: 36, height: 4 }}
    >
      <BottomSheetView style={{ paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl }}>
        {children}
      </BottomSheetView>
    </BottomSheetModal>
  );
}
