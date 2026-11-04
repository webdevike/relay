import { describe, expect, it } from "vitest";
import { emojify, reactionEmoji, slackEmoji } from "../src/index";

describe("emojify", () => {
  it("turns Slack shortcodes and their aliases into emoji", () => {
    expect(emojify("Ship it :clapper: :+1: :thumbsup: :white_check_mark:")).toBe(
      "Ship it 🎬 👍 👍 ✅",
    );
    expect(emojify("I may seek tips there :slightly_smiling_face:")).toBe(
      "I may seek tips there 🙂",
    );
  });

  it("applies skin tones", () => {
    expect(emojify(":+1::skin-tone-3:")).toBe("👍🏼");
    expect(emojify(":point_up::skin-tone-4:")).toBe("☝🏽");
    expect(slackEmoji("wave", "skin-tone-6")).toBe("👋🏿");
  });

  it("leaves custom emoji, code and times alone", () => {
    expect(emojify(":partyparrot: and :custom::skin-tone-2:")).toBe(
      ":partyparrot: and :custom::skin-tone-2:",
    );
    expect(emojify("run `:clapper:` then\n```\n:+1:\n```\n:+1:")).toBe(
      "run `:clapper:` then\n```\n:+1:\n```\n👍",
    );
    expect(emojify("at 10:30:45 on 2026-10-31")).toBe("at 10:30:45 on 2026-10-31");
  });

  it("keeps native emoji and text without colons as they are", () => {
    expect(emojify("Looks good 👍🏽 ✅")).toBe("Looks good 👍🏽 ✅");
    expect(slackEmoji("not_an_emoji")).toBeNull();
  });
});

describe("reactionEmoji", () => {
  it("takes a bare name, a toned name, a shortcode or the emoji", () => {
    expect(reactionEmoji("fire")).toBe("🔥");
    expect(reactionEmoji("+1::skin-tone-2")).toBe("👍🏻");
    expect(reactionEmoji(":white_check_mark:")).toBe("✅");
    expect(reactionEmoji("🙌")).toBe("🙌");
    expect(reactionEmoji("partyparrot")).toBe(":partyparrot:");
  });
});
