import { View } from "react-native";
import { useColors } from "@/theme";

export function Separator() {
  const colors = useColors();
  return <View style={{ height: 1, backgroundColor: colors.hairline }} />;
}
