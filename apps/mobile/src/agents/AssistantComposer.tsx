/**
 * The assistant thread's composer (`app/eva.tsx`), after the Claude app's. Idle: one floating pill
 * with attach, "Type or hold to talk" and the mic (the voice call is in the thread's header). Typing
 * (or a draft, queued photos, a dictation): a card above the keyboard with the field on top and
 * attach, the assistant/model chip and the mic under it, then send once there is something to send.
 *
 * The mic: a tap dictates into the field (x drops it, stop keeps the words to edit, the accent
 * arrow sends); a hold is walkie-talkie, sent when the finger lifts: the pill shows the live level
 * and the screen's edge glows (`ListeningOrb`, mounted by the screen through `onWalkie`), with no
 * transcript bubble. Holding the pill's open middle talks
 * the same way; tapping it starts typing.
 */
import { useEffect, useLayoutEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion, type SharedValue } from "react-native-reanimated";
import { useActorRef, useSelector } from "@xstate/react";
import { ComposerPill, COMPOSER_BUTTON, COMPOSER_FIELD } from "@/ui/ComposerPill";
import { AttachmentTray } from "@/ui/AttachmentTray";
import { IconButton } from "@/ui/IconButton";
import { Chip } from "@/ui/Chip";
import { LevelDots } from "@/ui/LevelDots";
import { Text } from "@/ui/Text";
import { motion, spacing, useColors, useScheme } from "@/theme";
import type { Photo } from "@/lib/photo";
import { expectKeyboard } from "@/lib/keyboardMotion";
import type { PopoverAnchor } from "@/agents/ThinkingPopover";
import { cardOpen, composerShapeMachine, holding as isHolding, tapDictating as isTapDictating } from "@/agents/composerShape.machine";
import { trackComposer } from "@/agents/composerShape";
import { ComposerMic } from "@/dictation/ComposerMic";
import { micLevel } from "@/dictation/signals";
import { dictationActor } from "@/dictation/actor";
import { useMicLevel } from "@/dictation/useMicLevel";
import { useDictation } from "@/dictation/useDictation";
import { useTapDictation } from "@/dictation/useTapDictation";
import { useHoldToTalkGesture } from "@/dictation/walkie";

/** Dark mode buttons inside the pill: one step lighter than its fill. */
const BUTTON_DARK = "#3A3A3A";

export interface AssistantComposerProps {
  title: string;
  connected: boolean;
  draft: string;
  setDraft: (text: string) => void;
  photos: Photo[];
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  /** The field, for Reply's quote and focus. */
  inputRef: RefObject<TextInput | null>;
  /** Where the field's cursor is, for Reply to quote above it. */
  cursor: RefObject<number>;
  onComposing: (focused: boolean) => void;
  onAttach: () => void;
  /** Sends a turn: the words and the queued photos. */
  onSend: (text: string, photos: Photo[]) => void;
  /** The model and its thinking level, in the card's chip; a tap gets the chip's place on screen, to open the level picker over it. */
  chip: { label: string; detail?: string | undefined; onPress: (anchor: PopoverAnchor) => void };
  /** A hold started: the screen shows the edge glow until it has faded. */
  onWalkie: () => void;
  /** The pill's height on screen, frame by frame (`ComposerPill` `height`). */
  height: SharedValue<number>;
}

export function AssistantComposer({ title, connected, draft, setDraft, photos, setPhotos, inputRef, cursor, onComposing, onAttach, onSend, chip, onWalkie, height }: AssistantComposerProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const button = dark ? BUTTON_DARK : colors.surfaceRaised;
  // The round send button: white on dark, near-black on light.
  const sendColors = dark ? { fill: "#FFFFFF", glyph: "#111111" } : { fill: "#1B1C1E", glyph: "#FFFFFF" };
  const { phase } = useDictation();
  useMicLevel(phase);
  // Leaving the thread mid-dictation aborts the recognizer (the actor outlives this screen).
  useEffect(
    () => () => {
      dictationActor.send({ type: "reset" });
    },
    [],
  );
  const tap = useTapDictation({
    draft,
    setDraft,
    send: (text) => {
      onSend(text, photos);
    },
  });
  // The pill or the card, and what the finger is doing with it (`composerShape.machine.ts`).
  const shape = useActorRef(composerShapeMachine, { input: { online: connected } });
  useEffect(() => trackComposer(shape), [shape]);
  useEffect(() => {
    shape.send({ type: "composer.connection", up: connected });
  }, [shape, connected]);
  // Before paint, so the card never shows the mic's slots for a frame after a tap dictation starts or ends.
  useLayoutEffect(() => {
    shape.send({ type: tap.dictating ? "composer.tapMic" : "composer.dictationLanded" });
  }, [shape, tap.dictating]);
  const open = useSelector(shape, cardOpen);
  const dictating = useSelector(shape, isTapDictating);
  const holding = useSelector(shape, isHolding);
  // A tap on the pill (or the mic) starts the keyboard's rise, opens the card and focuses the field
  // in the same tick, so card, keyboard and the lift on it are one motion from the first frame (the
  // collapsed field takes no touches of its own).
  const openCard = (): void => {
    expectKeyboard();
    shape.send({ type: "composer.tapPill" });
    inputRef.current?.focus();
  };
  const chipBox = useRef<View>(null);
  const hold = {
    onHoldStart: () => {
      shape.send({ type: "composer.holdStart" });
      onWalkie();
    },
    onHoldEnd: () => {
      shape.send({ type: "composer.holdEnd" });
    },
  };
  const pillGesture = useHoldToTalkGesture({
    enabled: connected,
    onTap: openCard,
    ...hold,
  });

  const text = draft.trim();
  const hasContent = text !== "" || photos.length > 0;
  const expanded = open || draft !== "" || photos.length > 0;
  // The finger is down on a hold: the pill shows the live level and "Release to send".
  const talking = holding && (phase === "listening" || phase === "requesting_permission");

  const field = (
    <TextInput
      ref={inputRef}
      value={tap.live}
      onChangeText={(next) => {
        // While dictating the field shows the live words; typing waits for stop.
        if (!tap.dictating) setDraft(next);
      }}
      onSelectionChange={(event) => {
        cursor.current = event.nativeEvent.selection.start;
      }}
      onFocus={() => {
        shape.send({ type: "composer.focus" });
        onComposing(true);
      }}
      onBlur={() => {
        shape.send({ type: "composer.blur" });
        onComposing(false);
      }}
      placeholder={!connected ? "Not connected" : expanded ? `Chat with ${title}` : "Type or hold to talk"}
      // Editable offline too: a reconnect must not drop the keyboard mid-word; the draft is kept and only sending waits.
      editable
      multiline
      scrollEnabled={expanded}
      keyboardAppearance={dark ? "dark" : "light"}
      placeholderTextColor={colors.textMuted}
      selectionColor={colors.accent}
      style={[styles.input, { color: colors.text }]}
      accessibilityLabel={`Message ${title}`}
    />
  );

  const attach = <IconButton symbol="plus" size={COMPOSER_BUTTON} glyphSize={19} backgroundColor={button} onPress={onAttach} disabled={!connected} accessibilityLabel="Attach image" />;
  const mic = (
    <ComposerMic
      size={COMPOSER_BUTTON}
      backgroundColor={button}
      enabled={connected}
      onTap={() => {
        tap.begin();
        openCard();
      }}
      {...hold}
    />
  );
  const send = hasContent && (
    <IconButton symbol="arrow.up" size={COMPOSER_BUTTON} glyphSize={18} backgroundColor={sendColors.fill} tintColor={sendColors.glyph} disabled={!connected} onPress={() => { onSend(text, photos); }} accessibilityLabel="Send" />
  );

  return (
    <View>
      <ComposerPill
        expanded={expanded}
        header={
          photos.length > 0 ? (
            <View style={styles.tray}>
              <AttachmentTray
                uris={photos.map((photo) => photo.uri)}
                onRemove={(index) => {
                  setPhotos((current) => current.filter((_, i) => i !== index));
                }}
              />
            </View>
          ) : undefined
        }
        field={field}
        leading={dictating ? <IconButton symbol="xmark" size={COMPOSER_BUTTON} glyphSize={17} backgroundColor={button} onPress={tap.cancel} accessibilityLabel="Cancel dictation" /> : attach}
        middle={
          dictating ? undefined : (
            <Animated.View entering={FadeIn.duration(motion.duration.base).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)} style={styles.chip}>
              <View ref={chipBox} collapsable={false} style={styles.chip}>
                <Chip
                  size="large"
                  label={chip.label}
                  detail={chip.detail}
                  onPress={() => {
                    chipBox.current?.measureInWindow((x, y, width, height) => {
                      chip.onPress({ x, y, width, height });
                    });
                  }}
                  style={[styles.chip, { backgroundColor: button }]}
                  accessibilityLabel={`${chip.label}${chip.detail === undefined ? "" : ` ${chip.detail}`}, change thinking`}
                />
              </View>
            </Animated.View>
          )
        }
        trailing={
          dictating ? (
            <>
              <LevelDots level={micLevel} count={13} height={16} color={colors.text} gap={4} />
              <IconButton symbol="stop.fill" size={COMPOSER_BUTTON} glyphSize={13} backgroundColor={button} onPress={tap.stop} accessibilityLabel="Stop dictation" />
              <IconButton symbol="arrow.up" size={COMPOSER_BUTTON} glyphSize={18} backgroundColor={colors.accent} tintColor="#FFFFFF" onPress={tap.send} accessibilityLabel="Send" />
            </>
          ) : (
            <>
              {mic}
              {send}
            </>
          )
        }
        gesture={pillGesture}
        height={height}
        overlay={
          talking ? (
            <>
              <LevelDots level={micLevel} count={22} height={26} color={colors.text} gap={5} />
              <Text variant="label" color="textMuted">
                Release to send
              </Text>
            </>
          ) : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  /** The same metrics in both shapes (`COMPOSER_FIELD`): opening the card moves the field, never restyles it. */
  input: { fontSize: 17, lineHeight: COMPOSER_FIELD.line, paddingHorizontal: spacing.xs, paddingTop: COMPOSER_FIELD.padTop, paddingBottom: COMPOSER_FIELD.padBottom, minHeight: COMPOSER_FIELD.min, maxHeight: COMPOSER_FIELD.max, textAlignVertical: "top" },
  chip: { flexShrink: 1, minWidth: 0 },
  tray: { paddingBottom: spacing.sm },
});
