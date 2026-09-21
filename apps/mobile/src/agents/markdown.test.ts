import { describe, expect, it } from "vitest";
import { splitFences, splitInline } from "./markdown";

describe("splitFences", () => {
  it("keeps prose on either side of a fence and lowercases the language", () => {
    expect(splitFences("before\n```TS\nconst a = 1;\n```\nafter")).toEqual([
      { kind: "text", text: "before" },
      { kind: "code", lang: "ts", code: "const a = 1;" },
      { kind: "text", text: "after" },
    ]);
  });

  it("treats an unterminated fence as code so a streaming reply highlights immediately", () => {
    expect(splitFences("look:\n```bash\nls -la")).toEqual([
      { kind: "text", text: "look:" },
      { kind: "code", lang: "bash", code: "ls -la" },
    ]);
  });

  it("does not close a backtick fence with tildes, and allows longer closers", () => {
    expect(splitFences("```\na\n~~~\nb\n````")).toEqual([{ kind: "code", lang: null, code: "a\n~~~\nb" }]);
  });

  it("ignores a fence marker that is not at the start of a line", () => {
    expect(splitFences("say ``` here")).toEqual([{ kind: "text", text: "say ``` here" }]);
  });
});

describe("splitInline", () => {
  it("splits code spans out of prose", () => {
    expect(splitInline("run `bun test` then `git push`")).toEqual([
      { code: false, text: "run " },
      { code: true, text: "bun test" },
      { code: false, text: " then " },
      { code: true, text: "git push" },
    ]);
  });

  it("leaves unbalanced, empty, or multi-line backticks literal", () => {
    expect(splitInline("a ` b")).toEqual([{ code: false, text: "a ` b" }]);
    expect(splitInline("a `` b")).toEqual([{ code: false, text: "a `` b" }]);
    expect(splitInline("a `x\ny` b")).toEqual([{ code: false, text: "a `x\ny` b" }]);
  });
});
