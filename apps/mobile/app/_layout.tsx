import { useEffect } from "react";
import { Appearance } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { useConnectionLifecycle } from "@/connection";
import { usePushNotifications } from "@/notifications";
import { useOtaUpdates } from "@/lib/otaUpdates";
import { useSettingsStore } from "@/state/settings";
import { useColors, useScheme } from "@/theme";
import { followLiveCalls } from "@/call/live";
import { LiveCallScreen } from "@/call/LiveCallScreen";

export default function RootLayout() {
  useConnectionLifecycle();
  usePushNotifications();
  useOtaUpdates();
  const appearance = useSettingsStore((state) => state.appearance);
  // Overrides the window's interface style, so useColorScheme, the keyboard, blur and native
  // chrome all follow the choice; null hands control back to iOS.
  useEffect(() => {
    Appearance.setColorScheme(appearance === "system" ? null : appearance);
  }, [appearance]);
  // Live calls run natively (the Action Button starts them with no JS); follow them once mounted.
  useEffect(() => {
    followLiveCalls();
  }, []);
  const colors = useColors();
  const scheme = useScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <BottomSheetModalProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            orientation: "portrait",
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="trackpad" options={{ orientation: "all" }} />
          <Stack.Screen name="screen" options={{ orientation: "all" }} />
          {/* Cards are thrown sideways; an edge swipe back would fight a throw that starts near the edge. */}
          <Stack.Screen name="catch-up" options={{ gestureEnabled: false }} />
          <Stack.Screen
            name="eva-computer"
            options={{ gestureEnabled: false, contentStyle: { backgroundColor: "#000000" } }}
          />
          {/* The board pans under the finger; an edge swipe back would leave the room mid-drag. Back to chat is the way out. */}
          <Stack.Screen name="canvas" options={{ gestureEnabled: false }} />
          <Stack.Screen
            name="eva-signin"
            options={{ presentation: "modal", contentStyle: { backgroundColor: colors.surface } }}
          />
          <Stack.Screen
            name="add-widget"
            options={{ presentation: "modal", contentStyle: { backgroundColor: colors.surface } }}
          />
        </Stack>
      </BottomSheetModalProvider>
      <LiveCallScreen />
    </GestureHandlerRootView>
  );
}
