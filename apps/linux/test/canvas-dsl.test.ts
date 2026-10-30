import { expect, test } from "vitest";
import { type Action, ActionParser } from "../src/canvas/dsl";

const SAMPLE = `@say Good call, the key reads as a list. Tightening it.
@select key-d1
@set_text key-d1 body
1 · Artifacts is a third panel tool

2 · Tabs: defaults first, then agent tabs
@end
@add_node n-why suggestion 1240 900 460
Why this order
Defaults stay put so muscle memory works.
@end
@add_edge key-d1 n-why because
@say Done.
`;

function run(chunks: string[]) {
  const actions: Action[] = [];
  let said = "";
  const p = new ActionParser((a) => actions.push(a), (s) => (said += s));
  for (const c of chunks) p.feed(c);
  p.finish();
  return { actions, said };
}

test("parses identically regardless of chunking", () => {
  const whole = run([SAMPLE]);
  for (const size of [1, 2, 3, 5, 7, 13]) {
    const chunks: string[] = [];
    for (let i = 0; i < SAMPLE.length; i += size) chunks.push(SAMPLE.slice(i, i + size));
    const r = run(chunks);
    expect(r.said).toBe(whole.said);
    expect(r.actions.map((a) => ("text" in a ? `${a.kind}:${a.text.text}:${a.text.closed}` : JSON.stringify(a)))).toEqual(
      whole.actions.map((a) => ("text" in a ? `${a.kind}:${a.text.text}:${a.text.closed}` : JSON.stringify(a))),
    );
  }
  expect(whole.said).toBe("Good call, the key reads as a list. Tightening it.\nDone.");
  const set = whole.actions[1];
  expect(set?.kind === "set_text" && set.text.text).toBe("1 · Artifacts is a third panel tool\n\n2 · Tabs: defaults first, then agent tabs");
  const add = whole.actions[2];
  expect(add?.kind === "add_node" && add.text.text).toBe("Why this order\nDefaults stay put so muscle memory works.");
  expect(whole.actions[3]).toEqual({ kind: "add_edge", source: "key-d1", target: "n-why", label: "because" });
});

test("parses the joined agents' actions: images with spaced paths, frames, cursor moves", () => {
  const { actions } = run([
    "@cursor 1200 -40\n@add_image shot-1 1200 0 820 /Users/ike/Library/Application Support/x/shot one.png\nInbox, GitHub view\nthe PR diff column\n@end\n@add_frame col-a 1180 -80 860 1400\nGitHub\n@end\n",
  ]);
  expect(actions[0]).toEqual({ kind: "cursor", x: 1200, y: -40 });
  const image = actions[1];
  expect(image?.kind === "add_image" && [image.src, image.w, image.text.text]).toEqual(["/Users/ike/Library/Application Support/x/shot one.png", 820, "Inbox, GitHub view\nthe PR diff column"]);
  const frame = actions[2];
  expect(frame?.kind === "add_frame" && [frame.id, frame.x, frame.y, frame.w, frame.h, frame.text.text]).toEqual(["col-a", 1180, -80, 860, 1400, "GitHub"]);
});
