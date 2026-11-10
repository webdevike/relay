import { describe, expect, it } from "vitest";
import { joinDictation, landDictation } from "./tapDictation";

describe("joinDictation", () => {
  it("puts the heard words after the draft with one space", () => {
    expect(joinDictation("Check the PR", " and ping Dana ")).toBe("Check the PR and ping Dana");
    expect(joinDictation("Check the PR   ", "and ping Dana")).toBe("Check the PR and ping Dana");
  });

  it("keeps a draft that ends a line on its own line", () => {
    expect(joinDictation("Notes:\n", "first item")).toBe("Notes:\nfirst item");
  });

  it("is just the words without a draft, and the draft untouched before any words", () => {
    expect(joinDictation("", "hello")).toBe("hello");
    expect(joinDictation("Draft ", "")).toBe("Draft ");
  });
});

describe("landDictation", () => {
  const run = { base: "Check the PR", interim: "Check the PR and ping", intent: "keep" as const };

  it("keep: the final words replace the interim while the draft is untouched", () => {
    expect(landDictation(run, "and ping Dana", run.interim)).toEqual({ send: null, draft: "Check the PR and ping Dana" });
  });

  it("keep: an edit made after stopping wins over late final words", () => {
    expect(landDictation(run, "and ping Dana", "Check the PR and ping Sam")).toEqual({ send: null, draft: undefined });
  });

  it("keep with nothing from the recognizer: the field keeps what it showed", () => {
    expect(landDictation(run, null, run.base)).toEqual({ send: null, draft: run.interim });
  });

  it("send: the draft and the final words go out as one turn", () => {
    expect(landDictation({ ...run, intent: "send" }, "and ping Dana", run.interim)).toEqual({ send: "Check the PR and ping Dana", draft: undefined });
  });

  it("send with nothing to say sends nothing and leaves the draft as it was", () => {
    expect(landDictation({ base: "", interim: "", intent: "send" }, null, "")).toEqual({ send: null, draft: "" });
  });

  it("cancel drops what was heard, even when final words arrive", () => {
    expect(landDictation({ ...run, intent: "cancel" }, "and ping Dana", run.interim)).toEqual({ send: null, draft: "Check the PR" });
  });

  it("an error mid-listening keeps the words the field showed", () => {
    expect(landDictation({ ...run, intent: null }, null, run.base)).toEqual({ send: null, draft: run.interim });
  });
});
