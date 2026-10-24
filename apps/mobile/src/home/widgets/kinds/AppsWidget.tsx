/**
 * Apps widget: Home's app list (`home/apps.ts`) as iOS Settings rows inside a widget. Large shows
 * every app, the rows sharing its height; medium shows as many whole rows from the top as fit.
 * Each row opens its app. There is no tap target behind the rows, so each row is a VoiceOver
 * element of its own carrying the grid's widget actions.
 */
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppRow, APP_ROW_MIN } from "@/home/AppRow";
import { useHomeApps } from "@/home/apps";
import { WidgetSurface, type WidgetBodyProps } from "../WidgetParts";

const INSET = 6;
/** Rows a medium widget shows before its height is measured: what fits a phone-width medium. */
const MEDIUM_ROWS = 3;

export function AppsWidget({ size, open, a11y }: WidgetBodyProps) {
  const apps = useHomeApps();
  const [fit, setFit] = useState(MEDIUM_ROWS);
  const shown = size === "large" ? apps : apps.slice(0, fit);
  return (
    <WidgetSurface
      label="Apps"
      href={null}
      open={open}
      a11y={a11y}
      style={styles.surface}
    >
      <View
        style={styles.rows}
        onLayout={(event) => {
          setFit(Math.max(1, Math.floor(event.nativeEvent.layout.height / APP_ROW_MIN)));
        }}
      >
        {shown.map((app, i) => (
          <AppRow key={app.key} app={app} first={i === 0} open={open} a11y={a11y} />
        ))}
      </View>
    </WidgetSurface>
  );
}

const styles = StyleSheet.create({
  surface: { paddingHorizontal: 0, paddingVertical: INSET },
  rows: { flex: 1 },
});
