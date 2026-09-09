import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useConnectionLifecycle } from "@/connection";
import { colors } from "@/theme";

export default function RootLayout() {
  useConnectionLifecycle();
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
