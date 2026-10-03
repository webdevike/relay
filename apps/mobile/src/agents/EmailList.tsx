/**
 * The ```ui "emails" widget: an inbox list on hairline dividers. Each row shows an unread dot,
 * sender (bold while unread), time, subject, and a two-line snippet; tapping a row expands the
 * full snippet, and the open glyph (shown when the row has a `url`) jumps to the message.
 */
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { tapHaptic } from "@/lib/haptics";
import { colors, spacing } from "@/theme";
import { Text } from "@/ui/Text";
import type { EmailSpec, EmailsSpec } from "./widget";

const DOT = 7;

export function EmailList({ spec }: { spec: EmailsSpec }) {
  return (
    <View>
      {spec.title !== undefined && (
        <Text variant="label" style={{ marginBottom: spacing.xs }}>
          {spec.title}
        </Text>
      )}
      {spec.emails.map((email, i) => (
        <EmailRow key={i} email={email} first={i === 0} />
      ))}
    </View>
  );
}

function EmailRow({ email, first }: { email: EmailSpec; first: boolean }) {
  const [open, setOpen] = useState(false);
  const unread = email.unread === true;
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        setOpen((v) => !v);
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: spacing.sm,
        paddingVertical: spacing.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.hairline,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ width: DOT, paddingTop: 6 }}>
        {unread && <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.accent }} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
          <Text variant="body" numberOfLines={1} style={{ flex: 1, fontWeight: unread ? "600" : "400" }}>
            {email.from}
          </Text>
          {email.date !== undefined && (
            <Text variant="caption" color="textMuted" tabular>
              {email.date}
            </Text>
          )}
        </View>
        <Text variant="label" color={unread ? "text" : "textMuted"} numberOfLines={open ? undefined : 1}>
          {email.subject}
        </Text>
        {email.snippet !== undefined && (
          <Text variant="caption" color="textMuted" numberOfLines={open ? undefined : 2}>
            {email.snippet}
          </Text>
        )}
      </View>
      {email.url !== undefined && (
        <Pressable
          hitSlop={10}
          onPress={() => {
            tapHaptic();
            if (email.url !== undefined) void Linking.openURL(email.url);
          }}
          style={({ pressed }) => ({ paddingTop: 2, opacity: pressed ? 0.6 : 1 })}
          accessibilityLabel="Open message"
        >
          <SymbolView name="arrow.up.right.square" size={16} tintColor={colors.textMuted} />
        </Pressable>
      )}
    </Pressable>
  );
}
