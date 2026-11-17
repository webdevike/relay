/**
 * The meeting view's rows: a transcript line (a minute stamp, "14m", in a narrow column beside the
 * words) and a key moment (its clock, "12:05"), plus the screen snapshots: a sideways strip of
 * thumbnails and the full-screen view one opens. Blue is the one accent: Isaac's own lines and
 * what is waiting on him.
 */
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";
import {
  KEY_MOMENT_LABEL,
  meetingClock,
  momentStamp,
  type KeyMoment,
  type MeetingRow,
  type MeetingShot,
} from "@relay/protocol";
import { radii, spacing, useColors, withAlpha } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { rowSpeaker, shotThumbWidth, shotUri } from "./panel";

/** The strip's thumbnails are this tall; their width follows the shot's shape. */
const THUMB_HEIGHT = 64;

export function TranscriptRow({
  row,
  blue,
  lit,
  onLayout,
}: {
  row: MeetingRow;
  blue: boolean;
  lit: boolean;
  onLayout: (e: LayoutChangeEvent) => void;
}) {
  const colors = useColors();
  return (
    <View
      testID="meeting-line"
      onLayout={onLayout}
      style={[
        styles.row,
        { backgroundColor: lit ? withAlpha(colors.accent, 0.14) : "transparent" },
      ]}
    >
      <Text variant="caption" color="textFaint" tabular style={styles.stamp}>
        {momentStamp(row.startMs)}
      </Text>
      <View style={styles.words}>
        <Text variant="caption" color={blue ? "accent" : "textMuted"} style={styles.speaker}>
          {rowSpeaker(row)}
        </Text>
        <Text color={row.draft ? "textMuted" : "text"}>{row.text}</Text>
      </View>
    </View>
  );
}

/**
 * A key moment: its clock, the one line and who said it (`who`, from `momentWho`); an ask still
 * waiting on Isaac reads in blue. With `onShot` a small picture glyph opens the snapshot that was
 * on screen then.
 */
export function MomentRow({
  moment,
  who,
  yours,
  onPress,
  onShot,
}: {
  moment: KeyMoment;
  who: string;
  yours: boolean;
  onPress: () => void;
  onShot?: (() => void) | undefined;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID="meeting-moment"
      accessibilityRole="button"
      accessibilityLabel={`${KEY_MOMENT_LABEL[moment.kind]} at ${meetingClock(moment.atMs)}: ${moment.text}. ${who}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? colors.surfaceRaised : "transparent" },
      ]}
    >
      <Text variant="caption" color="textFaint" tabular style={styles.clock}>
        {meetingClock(moment.atMs)}
      </Text>
      <View style={styles.words}>
        <Text color={yours ? "accent" : "text"} style={yours ? styles.yours : undefined}>
          {moment.text}
        </Text>
        <Text variant="caption" color={yours ? "accent" : "textMuted"}>
          {who}
        </Text>
      </View>
      {onShot !== undefined ? (
        <Pressable
          testID="meeting-moment-shot"
          accessibilityRole="imagebutton"
          accessibilityLabel="Open the screen snapshot from then"
          hitSlop={10}
          onPress={onShot}
          style={({ pressed }) => [styles.shotGlyph, { opacity: pressed ? 0.5 : 1 }]}
        >
          <SymbolView name="photo" size={15} tintColor={colors.textMuted} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/** The call's screen snapshots, newest first, each with its clock under it; a tap opens one. */
export function ShotStrip({
  shots,
  hostBase,
  onOpen,
}: {
  shots: readonly MeetingShot[];
  hostBase: string | null;
  onOpen: (shot: MeetingShot) => void;
}) {
  const colors = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="meeting-shots"
      // The strip runs to the screen's edges; the padding lines its first thumbnail up with the text.
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
    >
      {shots
        .slice()
        .reverse()
        .map((shot) => {
          const uri = shotUri(shot, hostBase);
          const width = shotThumbWidth(shot, THUMB_HEIGHT);
          return (
            <Pressable
              key={shot.n}
              testID="meeting-shot"
              accessibilityRole="imagebutton"
              accessibilityLabel={`Screen snapshot at ${meetingClock(shot.atMs)}`}
              onPress={() => {
                onOpen(shot);
              }}
              style={({ pressed }) => [styles.thumb, { opacity: pressed ? 0.85 : 1 }]}
            >
              <View
                style={[
                  styles.thumbFrame,
                  { width, backgroundColor: colors.surface, borderColor: colors.hairline },
                ]}
              >
                {uri !== null ? (
                  <Image source={{ uri }} resizeMode="cover" style={styles.thumbImage} />
                ) : null}
              </View>
              <Text variant="caption" color="textFaint" tabular>
                {meetingClock(shot.atMs)}
              </Text>
            </Pressable>
          );
        })}
    </ScrollView>
  );
}

/** One snapshot full screen: the picture at the screen's width, then its clock, line and the text on it. */
export function ShotViewer({
  shot,
  hostBase,
  onClose,
}: {
  shot: MeetingShot | null;
  hostBase: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const uri = shot === null ? null : shotUri(shot, hostBase);
  // As wide as the screen, never taller than most of it.
  const imageHeight = shot === null ? 0 : Math.min(height * 0.7, (width * shot.h) / shot.w);
  return (
    <Modal
      visible={shot !== null}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.viewer} testID="meeting-shot-viewer">
        {shot !== null ? (
          <ScrollView
            contentContainerStyle={{
              paddingTop: insets.top + spacing.xxxl,
              paddingBottom: insets.bottom + spacing.xl,
            }}
          >
            {uri !== null ? (
              <Image
                source={{ uri }}
                resizeMode="contain"
                style={{ width, height: imageHeight }}
                accessible
                accessibilityLabel={`Screen snapshot at ${meetingClock(shot.atMs)}`}
              />
            ) : (
              <View style={[styles.offline, { width, height: imageHeight }]}>
                <Text variant="caption" style={styles.viewerMuted}>
                  Connect to your Mac to see it.
                </Text>
              </View>
            )}
            <View style={styles.viewerText}>
              <Text variant="caption" tabular style={styles.viewerMuted}>
                {meetingClock(shot.atMs)}
              </Text>
              {shot.line !== "" ? <Text style={styles.viewerLine}>{shot.line}</Text> : null}
              {shot.ocr !== "" ? (
                <Text variant="caption" selectable style={styles.viewerMuted}>
                  {shot.ocr}
                </Text>
              ) : null}
            </View>
          </ScrollView>
        ) : null}
        <View style={[styles.viewerClose, { top: insets.top + spacing.sm }]}>
          <IconButton
            symbol="xmark"
            tone="overlay"
            size={36}
            glyphSize={16}
            accessibilityLabel="Close snapshot"
            onPress={onClose}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Lit and pressed backgrounds reach a little past the column; the padding gives it back.
  row: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: 7,
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  stamp: { width: 36, paddingTop: 2 },
  // Wide enough for "1:02:05".
  clock: { width: 52, paddingTop: 2 },
  words: { flex: 1 },
  speaker: { fontWeight: "600" },
  yours: { fontWeight: "500" },
  shotGlyph: { paddingTop: 3 },
  strip: { marginHorizontal: -spacing.xl },
  stripContent: { gap: spacing.sm, paddingHorizontal: spacing.xl },
  thumb: { gap: 3 },
  thumbFrame: {
    height: THUMB_HEIGHT,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  thumbImage: { width: "100%", height: "100%" },
  // The viewer is always dark, like the other full-screen pictures.
  viewer: { flex: 1, backgroundColor: "#000000" },
  offline: { alignItems: "center", justifyContent: "center" },
  viewerText: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.sm },
  viewerLine: { color: "#FFFFFF" },
  viewerMuted: { color: "rgba(255,255,255,0.65)" },
  viewerClose: { position: "absolute", right: spacing.md },
});
