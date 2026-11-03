import { describe, expect, it } from "vitest";
import { pushPreview } from "../src/push/preview";

describe("pushPreview", () => {
  it("shows the first line as plain text: emphasis, code, links and list or quote markers go", () => {
    expect(pushPreview("**Merged** `main` into [the branch](https://x/y), _finally_.\nSecond line.", 180)).toBe("Merged main into the branch, finally.");
    expect(pushPreview("- [x] Tests pass\n- Lint", 180)).toBe("Tests pass");
    expect(pushPreview("> Quoted ~~old~~ new", 180)).toBe("Quoted old new");
    expect(pushPreview("snake_case_name stays, 2 * 3 * 4 too", 180)).toBe("snake_case_name stays, 2 * 3 * 4 too");
    expect(pushPreview("![shot](/drops/a/b)\nHere is the screenshot.", 180)).toBe("Here is the screenshot.");
  });

  it("joins a heading or a lead-in with the line after it", () => {
    expect(pushPreview("## Done\nPR #12 is open.", 180)).toBe("Done: PR #12 is open.");
    expect(pushPreview("**Status**\n\nAll green.", 180)).toBe("Status: All green.");
    expect(pushPreview("Three things:\n1. One\n2. Two", 180)).toBe("Three things: One");
    expect(pushPreview("# Done", 180)).toBe("Done");
  });

  it("keeps whole sentences that fit, else cuts at a word", () => {
    const long = "Host 0.2.51 is live and the canvas fix shipped with it. The reminder runs at 9. Everything else waits for you.";
    expect(pushPreview(long, 80)).toBe("Host 0.2.51 is live and the canvas fix shipped with it. The reminder runs at 9.");
    expect(pushPreview(long, 40)).toBe("Host 0.2.51 is live and the canvas fix…");
  });

  it("drops a replies token and code blocks, and names a reply with nothing else", () => {
    expect(pushPreview("Push it now? [[replies: Yes | No]]", 180)).toBe("Push it now?");
    expect(pushPreview("```ts\nconst a = 1;\n```\nThat was the fix.", 180)).toBe("That was the fix.");
    expect(pushPreview("```html-widget\n<div>hi</div>\n```", 180)).toBe("Sent a widget");
    expect(pushPreview("```\nls\n```", 180)).toBe("Sent code");
    expect(pushPreview("![a](/drops/a/b)", 180)).toBe("Sent an image");
    expect(pushPreview("", 180)).toBe("");
  });
});
