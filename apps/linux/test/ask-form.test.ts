import { describe, expect, it } from "vitest";
import {
  formAsk,
  LEAVE_BLANK,
  type ChoiceField,
  type FormField,
  type FormHelpers,
  type FormOption,
  type ParsedForm,
  type TextField,
} from "../src/agents/ask-form";

// omp's html-form/data rules (choiceValue, textValue, defaultFormData, isArrayChoice) as omp 18.22.2
// ships them, over hand-built parsed forms shaped like parseHtmlForm's output.
const isArrayChoice = (field: ChoiceField): boolean => field.multi && field.options.length > 1;
const choiceValue = (field: ChoiceField, checked: ReadonlySet<number>, other?: string): unknown => {
  const typed = field.other ? other?.trim() : undefined;
  const values = field.options.flatMap((option, index) =>
    checked.has(index) && !option.disabled ? [option.value] : [],
  );
  if (isArrayChoice(field)) return typed ? [...values, typed] : values;
  return typed !== undefined && typed !== "" ? typed : values[0];
};
const textValue = (field: TextField, value: string): unknown => {
  if ((field.type === "number" || field.type === "range") && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
};
const helpers = (
  questions: Map<FormField, string>,
  contexts = new Map<FormField, string>(),
): FormHelpers => ({
  fieldQuestions: () => questions,
  fieldContexts: () => contexts,
  defaultFormData: (form: ParsedForm) => {
    const data: Record<string, unknown> = {};
    for (const field of form.fields) {
      if (field.name === "") continue;
      const value =
        field.kind === "text"
          ? textValue(field, field.value)
          : choiceValue(
              field,
              new Set(field.options.flatMap((option, index) => (option.checked ? [index] : []))),
            );
      if (value !== undefined) data[field.name] = value;
    }
    return data;
  },
  choiceValue,
  textValue,
  isArrayChoice,
});

const option = (value: string, label: string, checked = false, disabled = false): FormOption => ({
  value,
  label: [{ text: label }],
  checked,
  disabled,
});
const radios = (name: string, options: FormOption[], other = true): ChoiceField => ({
  kind: "choice",
  name,
  multi: false,
  other,
  options,
});

describe("formAsk", () => {
  // The form Nova sent on 2026-11-18 (trimmed): an intro paragraph, then radio fieldsets with the recommendation checked.
  const steps = radios("steps", [
    option("two", "  Two steps (recommended):\n a Purifier, then a Seeder.", true),
    option("one", "One step: straight to lush."),
    option("three", "Three steps: purify, water, seed."),
  ]);
  const fog = radios("fog", [
    option("blight-fog", "Blight fog (recommended)", true),
    option("atmosphere", "Just atmosphere"),
  ]);
  const form: ParsedForm = { fields: [steps, fog] };
  const ask = formAsk(
    form,
    helpers(
      new Map<FormField, string>([
        [steps, "1. How many steps from Blight to lush?"],
        [fog, "4. What is the fog?"],
      ]),
      new Map<FormField, string>([[steps, "Round 1 on Solstice's restoration loop."]]),
    ),
  );

  it("asks one question per field, led by the form text that goes with it, with the preset option recommended", () => {
    expect(ask.summary).toBe("1. How many steps from Blight to lush?");
    expect(ask.questions).toEqual([
      {
        id: "steps",
        question:
          "Round 1 on Solstice's restoration loop.\n\n1. How many steps from Blight to lush?",
        options: [
          { label: "Two steps (recommended): a Purifier, then a Seeder." },
          { label: "One step: straight to lush." },
          { label: "Three steps: purify, water, seed." },
        ],
        recommended: 0,
      },
      {
        id: "fog",
        question: "4. What is the fog?",
        options: [{ label: "Blight fog (recommended)" }, { label: "Just atmosphere" }],
        recommended: 0,
      },
    ]);
  });

  it("turns picks back into the option values, keeping presets for questions left unanswered", () => {
    expect(
      ask.data([{ id: "steps", selectedOptions: ["Three steps: purify, water, seed."] }]),
    ).toEqual({ steps: "three", fog: "blight-fog" });
  });

  it("takes typed text as the radio group's Other answer", () => {
    expect(
      ask.data([{ id: "fog", selectedOptions: [], customInput: "  volumetric, lifts slowly " }]),
    ).toEqual({ steps: "two", fog: "volumetric, lifts slowly" });
  });

  it("ignores answers to questions it never asked and labels it never showed", () => {
    expect(
      ask.data([
        { id: "nope", selectedOptions: ["x"] },
        { id: "fog", selectedOptions: ["Not an option"] },
      ]),
    ).toEqual({ steps: "two", fog: "blight-fog" });
  });

  it("makes checkboxes a multi-select whose picks and typed text make up the array", () => {
    const sides: ChoiceField = {
      kind: "choice",
      name: "sides",
      multi: true,
      other: true,
      options: [option("fries", "Fries", true), option("salad", "Salad"), option("soup", "Soup")],
    };
    const multi = formAsk(
      { fields: [sides] },
      helpers(new Map<FormField, string>([[sides, "Sides?"]])),
    );
    expect(multi.questions[0]).toMatchObject({ id: "sides", multi: true, recommended: 0 });
    expect(multi.data([{ id: "sides", selectedOptions: ["Salad", "Soup"] }])).toEqual({
      sides: ["salad", "soup"],
    });
  });

  it("drops disabled options, tells repeated labels apart and maps each back to its own value", () => {
    const size: ChoiceField = {
      kind: "choice",
      name: "size",
      multi: false,
      other: false,
      options: [
        option("s", "Small", false, true),
        option("m", "Medium"),
        option("m2", "Medium", true),
      ],
    };
    const select = formAsk({ fields: [size] }, helpers(new Map()));
    expect(select.questions[0]).toEqual({
      id: "size",
      question: "size",
      options: [{ label: "Medium" }, { label: "Medium (2)" }],
      recommended: 1,
    });
    expect(select.data([{ id: "size", selectedOptions: ["Medium"] }])).toEqual({ size: "m" });
    // A <select> has no Other in omp; what was typed still goes in as the answer.
    expect(select.data([{ id: "size", selectedOptions: [], customInput: "XL" }])).toEqual({
      size: "XL",
    });
  });

  it("asks a text field with its preset as the one option, or Leave blank, and takes typed text as its value", () => {
    const notes: TextField = { kind: "text", name: "notes", type: "textarea", value: "" };
    const count: TextField = { kind: "text", name: "count", type: "number", value: "3" };
    const text = formAsk(
      { fields: [notes, count] },
      helpers(
        new Map<FormField, string>([
          [notes, "Anything else?"],
          [count, "How many?"],
        ]),
      ),
    );
    expect(text.questions).toEqual([
      { id: "notes", question: "Anything else?", options: [{ label: LEAVE_BLANK }] },
      { id: "count", question: "How many?", options: [{ label: "3" }], recommended: 0 },
    ]);
    expect(
      text.data([
        { id: "notes", selectedOptions: [LEAVE_BLANK] },
        { id: "count", selectedOptions: ["3"] },
      ]),
    ).toEqual({ notes: "", count: 3 });
    expect(
      text.data([
        { id: "notes", selectedOptions: [], customInput: "ship it" },
        { id: "count", selectedOptions: [], customInput: "12" },
      ]),
    ).toEqual({
      notes: "ship it",
      count: 12,
    });
  });

  it("skips unnamed fields and fields with nothing to pick, and gives repeated names their own ids", () => {
    const unnamed: TextField = { kind: "text", name: "", type: "text", value: "" };
    const dead: ChoiceField = radios("dead", [option("a", "A", false, true)]);
    const first: TextField = { kind: "text", name: "n", type: "text", value: "" };
    const second: TextField = { kind: "text", name: "n", type: "text", value: "" };
    const repeated = formAsk({ fields: [unnamed, dead, first, second] }, helpers(new Map()));
    expect(repeated.questions.map((question) => question.id)).toEqual(["n", "n#2"]);
  });
});
