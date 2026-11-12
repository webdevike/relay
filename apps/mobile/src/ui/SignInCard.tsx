import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Text } from "./Text";
import { StatusCardRow } from "./StatusCardRow";
import { faviconUrl } from "@/eva/signin";
import { spacing, useColors } from "@/theme";

/** Side of the site icon's rounded square in the row. */
const ICON = 22;

export interface SignInCardProps {
  /** The card's name for dismissal: `signin:<agent>:<message id>`, as on desktop. */
  id: string;
  /** The site Eva needs Isaac to sign in to; its favicon and name head the card. */
  host: string;
  /** The host took the credentials: the card says so and no longer opens the sign-in. */
  submitted: boolean;
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
export function SignInCard({ id, host, submitted, onPress }: SignInCardProps) {
  const colors = useColors();
  return (
    <StatusCardRow
      // Desktop's id for the same card (`signin:<agent>:<message id>`), so a dismissal on either shows on both.
      id={id}
      running={!submitted}
      line={`Sign in to ${host}`}
      accessibilityLabel={`Sign in to ${host}`}
      lead={<SiteIcon host={host} size={ICON} />}
      meta={
        submitted ? (
          <View style={styles.meta}>
            <SymbolView name="checkmark" size={12} weight="semibold" tintColor={colors.accent} />
            <Text variant="caption" color="textMuted">
              Credentials submitted
            </Text>
          </View>
        ) : (
          <SymbolView name="plus" size={16} weight="semibold" tintColor={colors.textMuted} />
        )
      }
      {...(submitted ? {} : { onOpen: onPress })}
      testID="signin-card"
    />
  );
}

const styles = StyleSheet.create({
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
});
