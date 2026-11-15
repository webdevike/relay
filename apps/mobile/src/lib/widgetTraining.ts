/**
 * The 🎯 "Train on this" rules (protocol "Reply widgets"): when a reaction opens the one-question
 * sheet, the `widget.label` frame its answer sends, and what the phone says about the host's answer.
 */
import { reactionExcerpt, TRAIN_REACTION, type ClientMessage, type WidgetLabel } from "@relay/protocol";
import type { WidgetLabelAnswer } from "@/state/replyWidgets";

export type WidgetLabelFrame = Extract<ClientMessage, { t: "widget.label" }>;

/**
 * Whether a reaction opens the sheet: Isaac turned 🎯 on (`next` is the bubble's new reaction, null
 * when he took it back) on an assistant's reply in an assistant thread, on a host that takes labels.
 * Anywhere else 🎯 is a plain reaction.
 */
export function opensWidgetTraining(thread: string, key: string, next: string | null, trainingUp: boolean): boolean {
  return trainingUp && next === TRAIN_REACTION && thread.startsWith("assistant:") && key.startsWith("assistant@");
}

/** Isaac's answer for reply `key` of `thread` (`text` is the reply), read on the phone. */
export function widgetLabelFrame(thread: string, key: string, label: WidgetLabel, text: string): WidgetLabelFrame {
  return { t: "widget.label", thread, message: key, label, surface: "phone", excerpt: reactionExcerpt(text) };
}

/** The toast for the host's answer to a label. */
export function labelAnswerText(answer: WidgetLabelAnswer): string {
  return answer.ok ? "Saved for training" : "Label not saved";
}
