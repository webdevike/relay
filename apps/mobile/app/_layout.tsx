import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { useConnectionLifecycle } from "@/connection";
import { usePushNotifications } from "@/notifications";
import { colors } from "@/theme";

export default function RootLayout() {
  useConnectionLifecycle();
  usePushNotifications();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
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
