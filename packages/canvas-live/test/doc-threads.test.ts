import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  absolute,
  acceptSuggestion,
  addHunk,
  docThreadsOf,
  openDocThread,
  rejectAll,
  rejectSuggestion,
  relPos,
  sliceRuns,
  snapDocThreads,
  snapSuggestions,
  textAnchor,
  type Hunk,
} from "../src/doc-threads";
import type { ThreadMsg } from "../src/threads";

const BY = { name: "Nova", color: "#f76707", avatar: "/canvas/avatar/nova" };
const isaac = (text: string): ThreadMsg => ({ id: `m-${text}`, kind: "human", name: "Isaac", color: "#0ea5e9", text, ts: 1 });

/** A doc whose body is one paragraph: "Keep " + bold "every rule" + " short." and a second paragraph. */
function docWithText(): { doc: Y.Doc; body: Y.XmlFragment; text: Y.XmlText } {
  const doc = new Y.Doc();
  const body = doc.getXmlFragment("body");
  const p = new Y.XmlElement("paragraph");
  const second = new Y.XmlElement("paragraph");
  body.insert(0, [p, second]);
  const text = new Y.XmlText();
  p.insert(0, [text]);
  text.insert(0, "Keep ");
  text.insert(5, "every rule", { bold: true });
  text.insert(15, " short.", {});
  const other = new Y.XmlText();
  second.insert(0, [other]);
  other.insert(0, "Other block.");
  return { doc, body, text };
}

/** What an agent's find/replace does: delete the run, type the new text, record the hunk. */
function suggestReplace(doc: Y.Doc, text: Y.XmlText, index: number, length: number, replacement: string, thread: string | null): void {
  const removed = sliceRuns(text, index, index + length);
  text.delete(index, length);
  text.insert(index, replacement, {});
  const hunk: Hunk = { kind: "text", from: relPos(text, index), to: relPos(text, index + replacement.length, -1), removed };
  addHunk(doc, "s1", { thread, by: BY, ts: 2 }, hunk);
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

describe("doc threads", () => {
  it("anchors a thread to a run of text that follows edits before it", () => {
    const { doc, text } = docWithText();
    const threads = docThreadsOf(doc);
    expect(openDocThread(threads, "t-1", textAnchor(text, 5, 10, "every rule"), isaac("Shorter?"))).toBe(true);
    text.insert(0, "Always ");
    const [snap] = snapDocThreads(threads);
    expect(snap?.quote).toBe("every rule");
    const anchor = must(snap?.anchor);
    const from = absolute(doc, anchor.from);
    const to = absolute(doc, anchor.to);
    expect([from?.index, to?.index]).toEqual([12, 22]);
    // Typing right after the run does not grow it.
    text.insert(22, "!");
    expect(absolute(doc, anchor.to)?.index).toBe(22);
  });

  it("refuses a taken id and an empty first message", () => {
    const { doc, text } = docWithText();
    const threads = docThreadsOf(doc);
    const anchor = textAnchor(text, 0, 4, "Keep");
    expect(openDocThread(threads, "t-1", anchor, isaac("one"))).toBe(true);
    expect(openDocThread(threads, "t-1", anchor, isaac("two"))).toBe(false);
    expect(openDocThread(threads, "t-2", anchor, isaac("  "))).toBe(false);
  });
});

describe("suggestions", () => {
  it("reject restores the replaced text exactly, marks included, and re-anchors its thread", () => {
    const { doc, text } = docWithText();
    const before: unknown = text.toDelta();
    openDocThread(docThreadsOf(doc), "t-1", textAnchor(text, 5, 10, "every rule"), isaac("Shorter"));
    suggestReplace(doc, text, 5, 10, "rules", "t-1");
    expect(text.toString()).toBe("Keep rules short.");
    expect(snapSuggestions(doc)).toHaveLength(1);
    expect(rejectSuggestion(doc, "s1")).toBe(true);
    expect(text.toDelta()).toEqual(before);
    expect(snapSuggestions(doc)).toEqual([]);
    const anchor = must(snapDocThreads(docThreadsOf(doc))[0]?.anchor);
    expect(anchor.quote).toBe("every rule");
    expect([absolute(doc, anchor.from)?.index, absolute(doc, anchor.to)?.index]).toEqual([5, 15]);
  });

  it("reject keeps edits made elsewhere meanwhile", () => {
    const { doc, body, text } = docWithText();
    suggestReplace(doc, text, 5, 10, "rules", null);
    const other = (body.get(1) as Y.XmlElement).get(0) as Y.XmlText;
    other.insert(0, "Isaac: ");
    text.insert(0, ">");
    rejectSuggestion(doc, "s1");
    expect(text.toDelta()).toEqual([{ insert: ">Keep " }, { insert: "every rule", attributes: { bold: true } }, { insert: " short." }]);
    expect(other.toString()).toBe("Isaac: Other block.");
  });

  it("accept keeps the change and forgets the suggestion", () => {
    const { doc, text } = docWithText();
    suggestReplace(doc, text, 5, 10, "rules", null);
    expect(acceptSuggestion(doc, "s1")).toBe(true);
    expect(text.toString()).toBe("Keep rules short.");
    expect(snapSuggestions(doc)).toEqual([]);
    expect(rejectSuggestion(doc, "s1")).toBe(false);
  });

  it("rejecting inserted blocks removes exactly them, newest hunk first", () => {
    const { doc, body, text } = docWithText();
    suggestReplace(doc, text, 0, 4, "Make", null);
    const added = [new Y.XmlElement("paragraph"), new Y.XmlElement("paragraph")];
    body.insert(1, added);
    addHunk(doc, "s1", { thread: null, by: BY, ts: 3 }, { kind: "blocks", from: relPos(body, 1), to: relPos(body, 3, -1), removed: [] });
    // Isaac adds a block right after the suggested ones: it is not part of the suggestion.
    body.insert(3, [new Y.XmlElement("heading")]);
    rejectAll(doc);
    expect(body.toArray().map((el) => (el as Y.XmlElement).nodeName)).toEqual(["paragraph", "heading", "paragraph"]);
    expect(text.toString()).toContain("Keep ");
  });
});
