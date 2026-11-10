/**
 * A bottom sheet laid over the screen it is rendered in (not a portal modal: `ui/Sheet`'s
 * `BottomSheetModal` did not present on the assistant thread). Render it last inside a full-screen
 * container. It opens when `open` turns on, sizes to its content up to `MAX_SHARE` of the screen
 * (taller content scrolls), dims the page, and closes on a backdrop tap or a drag down; every close
 * reports through `onClose`. `header` stays put above the scrolling `children`. Text inputs inside
 * use `SheetTextInput` (`ui/Sheet`) so the keyboard cooperates.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radii, spacing, useColors } from "@/theme";

const MAX_SHARE = 0.8;

export interface OverlaySheetProps {
  open: boolean;
  onClose: () => void;
  header?: ReactNode;
  children: ReactNode;
}

function Backdrop(props: BottomSheetBackdropProps) {
  return <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} pressBehavior="close" />;
}

export function OverlaySheet({ open, onClose, header, children }: OverlaySheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const ref = useRef<BottomSheet>(null);
  useEffect(() => {
    if (open) ref.current?.snapToIndex(0);
    else ref.current?.close();
  }, [open]);
  return (
    <BottomSheet
      ref={ref}
      index={-1}
      enableDynamicSizing
      maxDynamicContentSize={height * MAX_SHARE}
      enablePanDownToClose
      topInset={insets.top}
      onChange={(index) => {
        if (index === -1 && open) onClose();
      }}
      backdropComponent={Backdrop}
      backgroundStyle={{ backgroundColor: colors.surface, borderRadius: radii.lg }}
      handleIndicatorStyle={{ backgroundColor: colors.hairline, width: 36, height: 4 }}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
    >
      {header}
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }} keyboardShouldPersistTaps="handled">
        {children}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}
