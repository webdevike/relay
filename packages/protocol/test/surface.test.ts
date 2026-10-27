import { describe, expect, it } from "vitest";
import { untagged } from "../src";

describe("untagged", () => {
  it("strips the desktop's tag", () => {
    expect(untagged("<surface>Mac Mini - Relay Desktop</surface>\nfix the dock")).toBe("fix the dock");
  });
  it("strips the phone's tag", () => {
    expect(untagged("<surface>iPhone - Relay</surface>\nship it")).toBe("ship it");
  });
  it("strips older history's EvaOS and terminal tags", () => {
    expect(untagged("<surface>Mac Mini - EvaOS</surface>\nhello")).toBe("hello");
    expect(untagged("  <surface>Mac Mini - Terminal</surface>\r\n\nhello")).toBe("hello");
  });
  it("keeps everything after the tag, and text without a leading tag as is", () => {
    expect(untagged("<surface>iPhone - Relay</surface>\na\n\nb")).toBe("a\n\nb");
    expect(untagged("plain words")).toBe("plain words");
    expect(untagged("quote: <surface>x</surface>")).toBe("quote: <surface>x</surface>");
    expect(untagged("<surface>unclosed")).toBe("<surface>unclosed");
  });
});
