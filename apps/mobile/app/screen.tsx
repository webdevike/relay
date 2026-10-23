/**
 * Live view: the Mac's whole desktop over VNC (macOS Screen Sharing), in noVNC (`ui/VncView`).
 * The host never exposes the VNC port: this screen asks it for a single-use ticket over the relay
 * socket (`requestVncAccess`) and opens the host's `/vnc` bridge with it, once per connection.
 * Screen Sharing's own login (a Mac account, or its VNC password) is asked once and kept in
 * Keychain per host; a refused login is forgotten and asked again. Tap clicks, two fingers scroll,
 * pinch zooms, the keyboard button types.
 */
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, StyleSheet, TextInput, View } from "react-native";
import { Screen } from "@/ui/Screen";
import { IconButton } from "@/ui/IconButton";
import { EmptyState } from "@/ui/EmptyState";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { VncView, type VncViewHandle } from "@/ui/VncView";
import { spacing } from "@/theme";
import { useConnectionStore } from "@/state/connection";
import { useVncStore } from "@/state/vnc";
import { requestVncAccess } from "@/connection";
import { forgetVncCredentials, loadVncCredentials, saveVncCredentials } from "@/vnc/credentials";
import type { VncCredentials, VncEvent, VncKey } from "@/vnc/messages";
import { useAnyOrientation } from "@/lib/useAnyOrientation";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

/** Where the live connection stands once the host handed over a ticket. */
type Phase = "connecting" | "live" | "login" | "dropped";

const DEFAULT_HOST = "default";
const REFUSED = "Screen Sharing didn't accept that login.";

export default function LiveView() {
  useAnyOrientation();
  const router = useRouter();
  const connected = useConnectionStore((state) => state.status === "connected");
  const hostId = useConnectionStore((state) => state.activeHostId) ?? DEFAULT_HOST;
  const access = useVncStore((state) => state.access);
  const [url, setUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  /** Saved login for `hostId`; undefined until Keychain answers. */
  const [credentials, setCredentials] = useState<VncCredentials | null | undefined>(undefined);
  /** The login fields Screen Sharing asked for, while the form is up. */
  const [wanted, setWanted] = useState<readonly string[]>([]);
  /** Set while the open connection waits for the form; otherwise a submit reconnects. */
  const awaitingLogin = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const vnc = useRef<VncViewHandle>(null);
  const keyboard = useRef<TextInput>(null);

  useEffect(() => {
    let current = true;
    setCredentials(undefined);
    loadVncCredentials(hostId).then(
      (saved) => {
        if (current) setCredentials(saved);
      },
      () => {
        if (current) setCredentials(null);
      },
    );
    return () => {
      current = false;
    };
  }, [hostId]);

  const loaded = credentials !== undefined;
  useEffect(() => {
    if (connected && loaded) requestVncAccess();
  }, [connected, loaded, hostId]);

  // A ticket opens one connection: take it out of the store as it becomes this screen's URL.
  useEffect(() => {
    if (access.kind !== "ready") return;
    setUrl(access.url);
    setPhase("connecting");
    useVncStore.getState().setAccess({ kind: "idle" });
  }, [access]);

  useEffect(
    () => () => {
      useVncStore.getState().setAccess({ kind: "idle" });
    },
    [],
  );

  const reconnect = (): void => {
    setPhase("connecting");
    requestVncAccess();
  };

  const onEvent = (event: VncEvent): void => {
    switch (event.type) {
      case "ready":
        return;
      case "connected":
        setFailure(null);
        setPhase("live");
        return;
      case "credentials":
        awaitingLogin.current = true;
        setWanted(event.types);
        setPhase("login");
        return;
      case "securityfailure":
        setFailure(event.reason ?? REFUSED);
        setCredentials(null);
        void forgetVncCredentials(hostId);
        setWanted((current) => (current.length > 0 ? current : ["username", "password"]));
        setPhase("login");
        return;
      case "disconnected":
        awaitingLogin.current = false;
        keyboard.current?.blur();
        setPhase((current) => (current === "login" ? current : "dropped"));
        return;
    }
  };

  const submitLogin = (login: VncCredentials): void => {
    setCredentials(login);
    void saveVncCredentials(hostId, login);
    if (awaitingLogin.current) {
      awaitingLogin.current = false;
      vnc.current?.send({ type: "credentials", credentials: login });
      setPhase("connecting");
    } else {
      reconnect();
    }
  };

  const sendKey = (key: VncKey): void => {
    vnc.current?.send({ type: "key", key });
  };

  if (!connected) {
    return (
      <Screen title="Live view">
        <EmptyState symbol="wifi.slash" title="Not connected" body="Live view needs a connection to your Mac." />
      </Screen>
    );
  }

  if (access.kind === "off") {
    return (
      <Screen title="Live view">
        <EmptyState
          symbol="display"
          title="Turn on Screen Sharing on the Mac"
          body="System Settings > General > Sharing > Screen Sharing. Relay reaches it through your Mac's own connection, so it stays off the network."
          actionLabel="Try again"
          onAction={requestVncAccess}
        />
      </Screen>
    );
  }

  return (
    <View style={styles.live}>
      <SafeAreaView style={styles.live} edges={["top", "bottom", "left", "right"]}>
        <VncView ref={vnc} url={url} credentials={credentials ?? null} onEvent={onEvent} />
        {phase === "connecting" && (
          <View pointerEvents="none" style={styles.overlay}>
            <Banner tone="info" busy message="Connecting to your Mac…" />
          </View>
        )}
        {phase === "dropped" && (
          <View style={styles.overlay}>
            <Banner tone="warn" message="Live view disconnected" actionLabel="Reconnect" onAction={reconnect} />
          </View>
        )}
        {phase === "login" && (
          <KeyboardAvoidingView behavior="padding" style={styles.overlay}>
            <LoginCard wantsUsername={wanted.includes("username")} failure={failure} onSubmit={submitLogin} />
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
      <SafeAreaView pointerEvents="box-none" style={styles.chrome} edges={["top", "bottom", "left", "right"]}>
        <View pointerEvents="box-none" style={styles.chromeRow}>
          <IconButton symbol="chevron.left" accessibilityLabel="Back" tintColor="#FFFFFF" backgroundColor="rgba(0,0,0,0.55)" onPress={() => router.back()} />
        </View>
        <View pointerEvents="box-none" style={[styles.chromeRow, styles.chromeEnd]}>
          <IconButton
            symbol="keyboard"
            accessibilityLabel="Keyboard"
            tintColor="#FFFFFF"
            backgroundColor="rgba(0,0,0,0.55)"
            disabled={phase !== "live"}
            onPress={() => {
              if (keyboard.current?.isFocused() === true) keyboard.current.blur();
              else keyboard.current?.focus();
            }}
          />
        </View>
      </SafeAreaView>
      <HiddenKeyboard inputRef={keyboard} onText={(text) => vnc.current?.send({ type: "text", text })} onKey={sendKey} />
    </View>
  );
}

/** Screen Sharing's login: a Mac account name and password, or only the VNC password. */
function LoginCard({ wantsUsername, failure, onSubmit }: { wantsUsername: boolean; failure: string | null; onSubmit: (login: VncCredentials) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const ready = password !== "" && (!wantsUsername || username.trim() !== "");
  const submit = (): void => {
    if (ready) onSubmit({ username: wantsUsername ? username.trim() : "", password });
  };
  return (
    <Card>
      <View style={styles.form}>
        <Text variant="title">Sign in to Screen Sharing</Text>
        <Text variant="caption" color="textMuted">
          {wantsUsername
            ? "The name and password of an account on the Mac. Saved on this phone."
            : "The VNC password set in the Mac's Screen Sharing settings. Saved on this phone."}
        </Text>
        {wantsUsername && <TextField value={username} onChangeText={setUsername} placeholder="Mac account name" credential="username" returnKeyType="next" />}
        <TextField value={password} onChangeText={setPassword} placeholder="Password" credential="password" returnKeyType="go" onSubmit={submit} />
        {failure !== null && <Banner tone="danger" message={failure} />}
        <Button label="Connect" disabled={!ready} onPress={submit} />
      </View>
    </Card>
  );
}

/**
 * Off-screen field that only exists to raise the iOS keyboard. Every change is sent and the field
 * cleared, so it never holds text; backspace and return are forwarded as keys.
 */
function HiddenKeyboard({ inputRef, onText, onKey }: { inputRef: React.RefObject<TextInput | null>; onText: (text: string) => void; onKey: (key: VncKey) => void }) {
  return (
    <TextInput
      ref={inputRef}
      style={styles.hidden}
      value=""
      autoCorrect={false}
      autoCapitalize="none"
      spellCheck={false}
      submitBehavior="submit"
      onChangeText={(text) => {
        if (text !== "") onText(text);
      }}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Backspace") onKey("backspace");
      }}
      onSubmitEditing={() => {
        onKey("return");
      }}
    />
  );
}

const styles = StyleSheet.create({
  live: { flex: 1, backgroundColor: "#000000" },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "center", padding: spacing.xl },
  form: { gap: spacing.md },
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, left: -100 },
  chrome: { ...StyleSheet.absoluteFillObject, justifyContent: "space-between", padding: spacing.md },
  chromeRow: { flexDirection: "row" },
  chromeEnd: { justifyContent: "flex-end" },
});
