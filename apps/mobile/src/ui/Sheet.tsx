/**
 * Bottom sheet on @gorhom/bottom-sheet: presents when `visible` turns on (or on mount), sizes to
 * its content, dims the screen, closes on backdrop tap or a drag down, and reports every close
 * through `onClose`. The whole content is one sheet-aware scroll view: it grows with the content
 * up to `MAX_SHARE` of the screen and scrolls past that, so a drag inside scrolls before it
 * dismisses. Nested scroll views would fight the sheet gesture; lay lists out as plain views.
 * Text inputs inside should use the `SheetTextInput` re-export so the keyboard cooperates.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { colors, radii, spacing } from "@/theme";

export { BottomSheetTextInput as SheetTextInput } from "@gorhom/bottom-sheet";

/** The sheet never grows past this share of the screen; taller content scrolls inside it. */
const MAX_SHARE = 0.85;

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
  const { height } = useWindowDimensions();
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
      maxDynamicContentSize={height * MAX_SHARE}
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      onDismiss={dismissed}
      backdropComponent={Backdrop}
      backgroundStyle={{ backgroundColor: colors.surface, borderRadius: radii.lg }}
      handleIndicatorStyle={{ backgroundColor: colors.hairline, width: 36, height: 4 }}
    >
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl }}>
        {children}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
