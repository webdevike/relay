/**
 * "Sign in to continue": the sheet behind a sign-in card in an assistant's thread (Dot's handoff). Two ways
 * through. `Username and password` reveals a form; submit sends `assistant.signin` for that agent, and the host
 * types the credentials into the login page in Eva's contained browser, so the model never sees
 * them. `Open Eva's browser` opens her computer for logins a form cannot do (Google, Apple,
 * passkeys). A full-screen modal route: the bottom-sheet modal did not present on the Eva screen.
 */
import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { MAX_SIGNIN_FIELD } from "@relay/protocol";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { SiteIcon } from "@/ui/SignInCard";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { spacing, useColors } from "@/theme";
import { sendCommand } from "@/connection";
import { signinFailure } from "@/eva/signin";
import { useAssistantStore } from "@/state/assistant";
import { notifyHaptic } from "@/lib/haptics";

const ICON = 48;

export default function EvaSignIn() {
  const colors = useColors();
  const router = useRouter();
  const { agent, messageId, url, host } = useLocalSearchParams<{ agent: string; messageId: string; url: string; host: string }>();
  const markSignedIn = useAssistantStore((state) => state.markSignedIn);
  const [form, setForm] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const ready = username.trim() !== "" && password !== "" && !busy;

  const submit = (): void => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    sendCommand({ kind: "assistant.signin", agent, messageId, url, username: username.trim(), password }).then(
      () => {
        notifyHaptic("success");
        markSignedIn(agent, messageId);
        router.dismiss();
      },
      (error: unknown) => {
        notifyHaptic("error");
        setFailure(signinFailure(error));
        setBusy(false);
      },
    );
  };

  const openBrowser = (): void => {
    router.dismiss();
    router.push("/eva-computer");
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.head}>
            <SiteIcon host={host} size={ICON} />
            <Text variant="title" style={styles.centered}>
              Sign in to continue
            </Text>
            <Text variant="label" color="textMuted" numberOfLines={2} style={styles.centered}>
              {url}
            </Text>
          </View>
          <View style={styles.options}>
            <Button
              label="Username and password"
              variant={form ? "primary" : "secondary"}
              disabled={busy}
              onPress={() => {
                setForm(true);
              }}
            />
            {form && (
              <View style={styles.form}>
                <Text variant="caption" color="textMuted">
                  Goes straight into the page in Eva's browser. She never sees it.
                </Text>
                <TextField
                  value={username}
                  onChangeText={(text) => {
                    setUsername(text.slice(0, MAX_SIGNIN_FIELD));
                  }}
                  placeholder="Username or email"
                  credential="username"
                  editable={!busy}
                  returnKeyType="next"
                />
                <TextField
                  value={password}
                  onChangeText={(text) => {
                    setPassword(text.slice(0, MAX_SIGNIN_FIELD));
                  }}
                  placeholder="Password"
                  credential="password"
                  editable={!busy}
                  returnKeyType="go"
                  onSubmit={submit}
                />
                {failure !== null && (
                  <View style={styles.banner}>
                    <Banner tone="danger" message={failure} />
                  </View>
                )}
                <Button label="Sign in" loading={busy} disabled={!ready} onPress={submit} />
              </View>
            )}
            <Button label="Open Eva's browser" variant="secondary" disabled={busy} onPress={openBrowser} />
            <Button
              label="Cancel"
              variant="ghost"
              disabled={busy}
              onPress={() => {
                router.dismiss();
              }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.xl, gap: spacing.xxl },
  head: { alignItems: "center", gap: spacing.sm, paddingTop: spacing.lg },
  centered: { textAlign: "center" },
  options: { gap: spacing.md },
  form: { gap: spacing.sm },
  banner: { marginHorizontal: -spacing.xl },
});
