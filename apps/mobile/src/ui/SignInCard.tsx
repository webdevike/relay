import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Text } from "./Text";
import { faviconUrl } from "@/eva/signin";
import { radii, spacing, useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

/** Side of the site icon's rounded square. */
const ICON = 32;
const ON_TINT = "#FFFFFF";
const ON_TINT_MUTED = "rgba(255,255,255,0.78)";

export interface SignInCardProps {
  /** The site Eva needs Isaac to sign in to; its favicon and name head the card. */
  host: string;
  /** The host took the credentials: the card tints `bubbleUser` and says so under the title. */
  submitted: boolean;
  /** Fill while the sign-in is open; the same as Eva's bubbles. */
  fill: string;
  onPress: () => void;
}

/** The site's icon in a rounded square; a globe stands in while it loads or when it fails. */
export function SiteIcon({ host, size = ICON }: { host: string; size?: number }) {
  const colors = useColors();
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: Math.round(size / 4), backgroundColor: colors.surfaceRaised, overflow: "hidden" } as const;
  if (failed) {
    return (
      <View style={[box, { alignItems: "center", justifyContent: "center" }]}>
        <SymbolView name="globe" size={Math.round(size * 0.55)} tintColor={colors.textMuted} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: faviconUrl(host) }}
      accessibilityLabel={host}
      onError={() => {
        setFailed(true);
      }}
      style={box}
    />
  );
}

/** Eva's request to sign in to a site: favicon, `Sign in to <host>`, a plus to open it, a check once submitted. */
export function SignInCard({ host, submitted, fill, onPress }: SignInCardProps) {
  const colors = useColors();
  const title = submitted ? ON_TINT : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Sign in to ${host}`}
      accessibilityState={{ disabled: submitted }}
      disabled={submitted}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        alignSelf: "flex-start",
        minWidth: 240,
        borderRadius: radii.lg,
        padding: spacing.md,
        backgroundColor: submitted ? colors.bubbleUser : fill,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <SiteIcon host={host} />
        <Text variant="title" numberOfLines={1} style={{ flex: 1, color: title }}>
          {`Sign in to ${host}`}
        </Text>
        <SymbolView name={submitted ? "checkmark" : "plus"} size={18} weight="semibold" tintColor={title} />
      </View>
      {submitted && (
        <Text variant="caption" style={{ marginTop: spacing.xs, marginLeft: ICON + spacing.md, color: ON_TINT_MUTED }}>
          Credentials submitted
        </Text>
      )}
    </Pressable>
  );
}
