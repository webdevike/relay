import { useEffect } from "react";
import { Appearance } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { useConnectionLifecycle } from "@/connection";
import { usePushNotifications } from "@/notifications";
import { useSettingsStore } from "@/state/settings";
import { useColors, useScheme } from "@/theme";

export default function RootLayout() {
  useConnectionLifecycle();
  usePushNotifications();
  const appearance = useSettingsStore((state) => state.appearance);
  // Overrides the window's interface style, so useColorScheme, the keyboard, blur and native
  // chrome all follow the choice; null hands control back to iOS.
  useEffect(() => {
    Appearance.setColorScheme(appearance === "system" ? null : appearance);
  }, [appearance]);
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
        </Stack>
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}
