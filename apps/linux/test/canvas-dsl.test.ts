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
