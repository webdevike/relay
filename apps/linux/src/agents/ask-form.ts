// omp's `ask` tool as a Relay ask card. Since omp 18.18.3 the tool takes one HTML <form> and opens
// it with `ui.formDialog` (the terminal's form dialog) instead of `ui.askDialog`'s question list, so
// the relay-bridge extension mirrors the form: each named field becomes one card question, and the
// card's answers become the form data the dialog resolves with. Used by that extension, which
// imports it by relative path under omp's bun, so this file may only use node built-ins (and type
// imports, which are erased). omp's own form parser and data rules are handed in as FormHelpers.

import type { AgentAskAnswer, AgentAskOption, AgentAskQuestion } from "@relay/protocol";

/** The parts of omp's parsed form (`@oh-my-pi/pi-tui/html-form/parse` parseHtmlForm) the card reads. */
export interface FormSpan {
  readonly text: string;
}
export interface FormOption {
  readonly value: string;
  readonly label: readonly FormSpan[];
  readonly checked: boolean;
  readonly disabled: boolean;
}
/** Radios, checkboxes or a <select>; `other` means a typed answer is the field's value (omp's "Other"). */
export interface ChoiceField {
  readonly kind: "choice";
  readonly name: string;
  readonly multi: boolean;
  readonly other: boolean;
  readonly options: readonly FormOption[];
}
/** An <input> of a text-like type, or a <textarea>; `value` is what the form preset. */
export interface TextField {
  readonly kind: "text";
  readonly name: string;
  readonly type: string;
  readonly value: string;
}
export type FormField = ChoiceField | TextField;
export interface ParsedForm {
  readonly fields: readonly FormField[];
}

/** omp's form semantics (`@oh-my-pi/pi-tui/html-form/data`), so a card answer means what the same answer means in the terminal. */
export interface FormHelpers {
  /** The question each field asks: its label, else the text or legend before it, else its name. */
  fieldQuestions(form: ParsedForm): ReadonlyMap<FormField, string>;
  /** The form's other text (intro paragraphs, lists) each field belongs with. */
  fieldContexts(form: ParsedForm): ReadonlyMap<FormField, string>;
  /** The data the form submits untouched: every preset value plus the hidden inputs. */
  defaultFormData(form: ParsedForm): Record<string, unknown>;
  /** A choice field's value for the checked option indices and a typed "Other" answer. */
  choiceValue(field: ChoiceField, checked: ReadonlySet<number>, other?: string): unknown;
  /** A text field's value for what was typed (numbers for number and range inputs). */
  textValue(field: TextField, value: string): unknown;
  /** Whether the field's value is an array (checkboxes or a multiple <select> with more than one option). */
  isArrayChoice(field: ChoiceField): boolean;
}

/** The one option a text field with nothing preset shows: picking it submits the field empty. Typing is the other way to answer. */
export const LEAVE_BLANK = "Leave blank";

/** Longest option label a preset text value shows as (the full value is what gets submitted). */
const MAX_PRESET_LABEL = 200;

/** One card question and the form field it stands for; `labels[i]` is the option `indices[i]` of the field. */
interface Slot {
  readonly field: FormField;
  readonly labels: readonly string[];
  readonly indices: readonly number[];
}

/** The card for one form, and how its answers turn back into the form's data. */
export interface FormAsk {
  readonly questions: AgentAskQuestion[];
  /** The first question alone, without the form text before it: what the session's status says it waits on. */
  readonly summary: string;
  /** The data the form dialog resolves with: the card's answers over the form's preset values. */
  data(answers: readonly AgentAskAnswer[]): Record<string, unknown>;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `label`, or `label (2)`, `label (3)`... when an earlier option already reads the same (the card keys options by label). */
function distinct(label: string, taken: Set<string>): string {
  let candidate = label;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${label} (${String(n)})`;
  taken.add(candidate);
  return candidate;
}

/** The card question for a choice field: its enabled options, the preset one marked recommended. */
function choiceSlot(
  field: ChoiceField,
  isArray: boolean,
): { slot: Slot; options: AgentAskOption[]; recommended: number; multi: boolean } | null {
  const taken = new Set<string>();
  const labels: string[] = [];
  const indices: number[] = [];
  let recommended = -1;
  field.options.forEach((option, index) => {
    if (option.disabled) return;
    if (option.checked && recommended < 0) recommended = labels.length;
    const text = option.label.map((span) => span.text).join("");
    labels.push(distinct(oneLine(text) || option.value || String(index + 1), taken));
    indices.push(index);
  });
  if (labels.length === 0) return null;
  return {
    slot: { field, labels, indices },
    options: labels.map((label) => ({ label })),
    recommended,
    multi: isArray,
  };
}

/** The card question for a text field: its preset value as the one option, else LEAVE_BLANK; typing answers it. */
function textSlot(field: TextField): {
  slot: Slot;
  options: AgentAskOption[];
  recommended: number;
  multi: boolean;
} {
  const preset = oneLine(field.value);
  const label =
    preset === ""
      ? LEAVE_BLANK
      : preset.length > MAX_PRESET_LABEL
        ? `${preset.slice(0, MAX_PRESET_LABEL - 1)}…`
        : preset;
  return {
    slot: { field, labels: [label], indices: [0] },
    options: [{ label }],
    recommended: preset === "" ? -1 : 0,
    multi: false,
  };
}

/**
 * The card for `form`: one question per named field, in form order (unnamed fields submit nothing,
 * as in omp). Question ids are the field names (`name#2` for a repeat), the form's text that goes
 * with a field leads its question (as omp's own field-by-field prompts show it), and a preset
 * choice is the recommended option.
 */
export function formAsk(form: ParsedForm, helpers: FormHelpers): FormAsk {
  const questionOf = helpers.fieldQuestions(form);
  const contextOf = helpers.fieldContexts(form);
  const slots = new Map<string, Slot>();
  const questions: AgentAskQuestion[] = [];
  let summary = "";
  for (const field of form.fields) {
    if (field.name === "") continue;
    const shaped =
      field.kind === "choice" ? choiceSlot(field, helpers.isArrayChoice(field)) : textSlot(field);
    if (shaped === null) continue;
    let id = field.name;
    for (let n = 2; slots.has(id); n += 1) id = `${field.name}#${String(n)}`;
    slots.set(id, shaped.slot);
    const asked = oneLine(questionOf.get(field) ?? "") || field.name;
    const context = contextOf.get(field)?.trim() ?? "";
    if (questions.length === 0) summary = asked;
    const question: AgentAskQuestion = {
      id,
      question: context === "" ? asked : `${context}\n\n${asked}`,
      options: shaped.options,
    };
    if (shaped.multi) question.multi = true;
    if (shaped.recommended >= 0) question.recommended = shaped.recommended;
    questions.push(question);
  }

  const data = (answers: readonly AgentAskAnswer[]): Record<string, unknown> => {
    const out = helpers.defaultFormData(form);
    const put = (name: string, value: unknown): void => {
      if (value === undefined) Reflect.deleteProperty(out, name);
      else out[name] = value;
    };
    for (const answer of answers) {
      const slot = slots.get(answer.id);
      if (slot === undefined) continue;
      const typed = answer.customInput?.trim() ?? "";
      const { field } = slot;
      if (field.kind === "text") {
        // Typed text is the answer; LEAVE_BLANK empties the field; the preset option keeps the preset.
        if (typed !== "") put(field.name, helpers.textValue(field, answer.customInput ?? typed));
        else if (field.value.trim() === "" && answer.selectedOptions.includes(LEAVE_BLANK))
          put(field.name, helpers.textValue(field, ""));
        continue;
      }
      const checked = new Set(
        answer.selectedOptions.flatMap((label) => {
          const at = slot.labels.indexOf(label);
          const index = slot.indices[at];
          return at < 0 || index === undefined ? [] : [index];
        }),
      );
      if (typed === "" && checked.size === 0) continue; // unanswered: the preset stands
      if (typed === "" || field.other) {
        put(field.name, helpers.choiceValue(field, checked, typed === "" ? undefined : typed));
        continue;
      }
      // A <select> takes no "Other" in omp, but what Isaac typed is still his answer: it goes in as typed.
      const picked = [...checked].flatMap((index) => {
        const option = field.options[index];
        return option === undefined ? [] : [option.value];
      });
      put(field.name, helpers.isArrayChoice(field) ? [...picked, typed] : typed);
    }
    return out;
  };

  return { questions, summary, data };
}
