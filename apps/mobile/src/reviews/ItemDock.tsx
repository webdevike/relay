/**
 * The bottom of an item's screen (Linear's issue view). Not typing: a glass capsule of Unread |
 * Snooze | Done over the inbox button, the "+ Comment" pill and Ask Astra. Typing: one rounded card
 * over the keyboard with the field on top, image and @ at the bottom left and the send disc at the
 * bottom right, @mention suggestions over it. The keyboard going down folds an empty draft back
 * into the bars. Posts still go out only from the confirm sheet.
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { spacing, useColors } from "@/theme";
import { Chip } from "@/ui/Chip";
import { FloatingPill, FloatingPillInput } from "@/ui/FloatingPill";
import { GlassBar, GlassButton } from "@/ui/Glass";
import { IconButton } from "@/ui/IconButton";
import { SuggestionList } from "@/ui/SuggestionList";
import { Text } from "@/ui/Text";
import { markReviewDone, markReviewRead, snoozeReview } from "./actions";
import { ConfirmSheet } from "./ConfirmSheet";
import { insertMention, mentionCandidates, mentionQuery } from "./model";
import { SnoozeSheet } from "./SnoozeSheet";
import type { ReviewComposer } from "./useReviewComposer";

/** Mention rows shown at once; typing narrows them. */
const MAX_MENTIONS = 5;

export interface ItemDockProps {
  composer: ReviewComposer;
  url: string;
  /** The item's `updatedAt` for Done and Unread; until it is known they use now. */
  updatedAt: number | undefined;
  /** The card's placeholder: "Comment", Slack's "Reply". */
  placeholder: string;
  /** Who `@` can name besides Astra: the people on the item. */
  people: readonly string[];
  /** Linear's "Reply in thread" target, shown as a chip in the card; a tap on it goes back to a top-level comment. */
  replyingTo?: string | null | undefined;
  onClearReply?: (() => void) | undefined;
  /** A short message for the screen's toast (a failed Done, Unread or Snooze). */
  notify: (message: string) => void;
}

export function ItemDock({ composer, url, updatedAt, placeholder, people, replyingTo, onClearReply, notify }: ItemDockProps) {
  const colors = useColors();
  const router = useRouter();
  const [snoozing, setSnoozing] = useState(false);
  const collapse = useRef(composer.collapse);
  collapse.current = composer.collapse;

  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidHide", () => {
      collapse.current();
    });
    return () => {
      sub.remove();
    };
  }, []);

  const toQueue = () => {
    router.dismissTo("/reviews");
  };
  const report = (failure: string | null) => {
    if (failure !== null) notify(failure);
  };

  const query = mentionQuery(composer.draft);
  const mentions = query === null ? [] : mentionCandidates(people, query).slice(0, MAX_MENTIONS);
  const empty = composer.draft.trim() === "";

  return (
    <>
      {composer.open ? (
        <>
          {mentions.length > 0 && (
            <SuggestionList
              suggestions={mentions.map((name) => ({ key: name, title: name, hint: name === "Astra" ? "asks privately" : undefined }))}
              onPick={(name) => {
                composer.setDraft(insertMention(composer.draft, name));
              }}
            />
          )}
          <FloatingPill
            expanded
            leading={
              <View style={styles.tools}>
                {composer.attachImage !== null && (
                  <IconButton
                    symbol="photo"
                    size={36}
                    backgroundColor="transparent"
                    tintColor={colors.textMuted}
                    accessibilityLabel="Add image"
                    testID="review-composer-image"
                    disabled={composer.uploading}
                    onPress={composer.attachImage}
                  />
                )}
                <IconButton
                  symbol="at"
                  size={36}
                  backgroundColor="transparent"
                  tintColor={colors.textMuted}
                  accessibilityLabel="Mention"
                  testID="review-composer-mention"
                  onPress={() => {
                    if (mentionQuery(composer.draft) === null) composer.setDraft(`${composer.draft}${composer.draft === "" || /\s$/.test(composer.draft) ? "" : " "}@`);
                  }}
                />
              </View>
            }
            trailing={
              <IconButton
                symbol="arrow.up"
                size={34}
                backgroundColor={empty ? colors.surfaceRaised : colors.text}
                tintColor={empty ? colors.textFaint : colors.bg}
                disabledOpacity={1}
                accessibilityLabel="Send"
                testID="review-composer-send"
                disabled={empty || composer.uploading}
                onPress={composer.send}
              />
            }
          >
            {replyingTo !== undefined && replyingTo !== null && (
              <View style={styles.above}>
                <Chip
                  label={`Replying to ${replyingTo}`}
                  accessibilityLabel={`Replying to ${replyingTo}, tap to cancel`}
                  leading={<SymbolView name="xmark" size={10} tintColor={colors.textMuted} />}
                  onPress={() => {
                    onClearReply?.();
                  }}
                />
              </View>
            )}
            {composer.uploading && (
              <View style={[styles.above, styles.uploading]} accessibilityLabel="Uploading image">
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text variant="caption" color="textMuted">
                  Uploading image…
                </Text>
              </View>
            )}
            <FloatingPillInput value={composer.draft} onChangeText={composer.setDraft} placeholder={placeholder} accessibilityLabel={placeholder} testID="review-composer-field" tall autoFocus />
          </FloatingPill>
        </>
      ) : (
        <>
          <GlassBar
            segments={[
              {
                key: "unread",
                symbol: "envelope.badge",
                label: "Unread",
                accessibilityLabel: "Mark unread",
                testID: "review-unread",
                onPress: () => {
                  void markReviewRead(url, updatedAt ?? Date.now(), false).then(report);
                  toQueue();
                },
              },
              {
                key: "snooze",
                symbol: "clock",
                label: "Snooze",
                testID: "review-snooze",
                onPress: () => {
                  setSnoozing(true);
                },
              },
              {
                key: "done",
                symbol: "checkmark",
                label: "Done",
                accessibilityLabel: "Mark Done",
                testID: "review-done",
                onPress: () => {
                  void markReviewDone(url, updatedAt ?? Date.now()).then(report);
                  toQueue();
                },
              },
            ]}
          />
          <View style={styles.row}>
            <GlassButton symbol="tray" accessibilityLabel="Reviews inbox" testID="review-inbox" onPress={toQueue} />
            <GlassBar
              style={styles.grow}
              segments={[
                {
                  key: "comment",
                  symbol: "plus",
                  label: placeholder,
                  accessibilityLabel: placeholder,
                  testID: "review-comment",
                  onPress: () => {
                    composer.compose();
                  },
                },
              ]}
            />
            <GlassButton
              symbol="sparkles"
              accessibilityLabel="Ask Astra"
              testID="review-ask-astra"
              onPress={() => {
                composer.compose("@Astra ");
              }}
            />
          </View>
        </>
      )}
      <SnoozeSheet
        visible={snoozing}
        onClose={() => {
          setSnoozing(false);
        }}
        onPick={(until) => {
          setSnoozing(false);
          void snoozeReview(url, until).then(report);
          toQueue();
        }}
      />
      <ConfirmSheet post={composer.pending} busy={composer.posting} error={composer.postError} onCancel={composer.cancel} onConfirm={composer.post} />
    </>
  );
}

const styles = StyleSheet.create({
  tools: { flexDirection: "row", alignItems: "center" },
  above: { flexDirection: "row", paddingTop: spacing.md },
  uploading: { alignItems: "center", gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  grow: { flex: 1 },
});
