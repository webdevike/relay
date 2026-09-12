import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useConnectionLifecycle } from "@/connection";
import { usePushNotifications } from "@/notifications";
import { colors } from "@/theme";

export default function RootLayout() {
  useConnectionLifecycle();
  usePushNotifications();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          orientation: "portrait",
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="trackpad" options={{ orientation: "all" }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
