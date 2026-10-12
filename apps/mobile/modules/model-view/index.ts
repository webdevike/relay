/**
 * Native glTF viewer (SceneKit, models loaded with GLTFKit2): framed to fit, one-finger drag
 * orbits, pinch zooms, optional turntable spin until touched. The native side lives in
 * ios/ModelViewModule.swift; it downloads `src` itself, so no web view or CDN is involved.
 */
import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

export interface NativeModelViewProps extends ViewProps {
  /** http(s) URL of a GLB, or of a glTF whose buffers and images are embedded. */
  src: string;
  autoRotate?: boolean | undefined;
  onLoad?: (() => void) | undefined;
  onError?: ((event: NativeSyntheticEvent<{ message: string }>) => void) | undefined;
}

export const NativeModelView = requireNativeView<NativeModelViewProps>("ModelView");
