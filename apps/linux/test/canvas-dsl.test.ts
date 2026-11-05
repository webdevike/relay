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
    expect(r.actions.map((a) => ("text" in a && typeof a.text !== "string" ? `${a.kind}:${a.text.text}:${a.text.closed}` : JSON.stringify(a)))).toEqual(
      whole.actions.map((a) => ("text" in a && typeof a.text !== "string" ? `${a.kind}:${a.text.text}:${a.text.closed}` : JSON.stringify(a))),
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

test("parses @parent with a frame id or none", () => {
  const { actions } = run(["@parent img-list grp-screens\n@parent img-list none\n@parent lonely\n"]);
  expect(actions).toEqual([
    { kind: "parent", id: "img-list", frame: "grp-screens" },
    { kind: "parent", id: "img-list", frame: null },
  ]);
});

test("parses @add_ui with an optional height, keeping the OpenUI source's @-calls inside the block", () => {
  const source = 'root = Card([s, refresh], "Jobs")\njobs = Query("jobs", {}, {failing: 0}, 30)\ns = Stat("Failing", "" + jobs.failing)\nrefresh = Button("Refresh", @Run(jobs))';
  const text = `@add_ui live-jobs 100 -40 480 300\nJobs last run\n${source}\n@end\n@add_ui auto 0 0 400\nT\nroot = Text("x")\n@end\n`;
  for (const size of [1, 4, text.length]) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const { actions } = run(chunks);
    const [ui, auto] = actions;
    expect(ui?.kind === "add_ui" && [ui.id, ui.x, ui.y, ui.w, ui.h, ui.text.text, ui.text.closed]).toEqual(["live-jobs", 100, -40, 480, 300, `Jobs last run\n${source}`, true]);
    expect(auto?.kind === "add_ui" && auto.h).toBeNull();
  }
});

test("parses @add_proto with an optional height, the design system and a mobile viewport, keeping JSX lines whole", () => {
  const jsx = 'const [n, setN] = useState(0);\n\nreturn <Button onClick={() => setN(n + 1)}>{n}</Button>;';
  const text = `@add_proto assets 0 600 960 640 ecard\nPlatform Assets\n${jsx}\n@end\n@add_proto approve 1000 600 430 relay mobile\nApprove\n<Text>Hi</Text>\n@end\n@add_proto plain 0 0 0 Mantine\nT\n<Text />\n@end\n`;
  for (const size of [1, 5, text.length]) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const [assets, approve, plain] = run(chunks).actions;
    expect(assets?.kind === "add_proto" && [assets.id, assets.x, assets.y, assets.w, assets.h, assets.system, assets.viewport, assets.text.text]).toEqual([
      "assets", 0, 600, 960, 640, "ecard", "desktop", `Platform Assets\n${jsx}`,
    ]);
    expect(approve?.kind === "add_proto" && [approve.w, approve.h, approve.system, approve.viewport]).toEqual([430, null, "relay", "mobile"]);
    expect(plain?.kind === "add_proto" && [plain.w, plain.system]).toEqual([960, "mantine"]);
  }
});

test("parses the comment-thread actions: @reply, @pin on a node or a spot, @resolve and @reopen", () => {
  const text = "@say Looking.\n@reply t-1 Renamed it, the key reads Roles now.\n@pin t-q root Is support staff or a role?\n@pin t-spot -120 40.5 Room for the filters here\n@resolve t-1\n@reopen t-1\n@reply t-2\n@pin t-bad root\n@pin\n";
  for (const size of [1, 3, text.length]) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const { actions, said } = run(chunks);
    expect(said).toBe("Looking.");
    expect(actions).toEqual([
      { kind: "reply", thread: "t-1", text: "Renamed it, the key reads Roles now." },
      { kind: "pin", id: "t-q", node: "root", x: 0, y: 0, text: "Is support staff or a role?" },
      { kind: "pin", id: "t-spot", node: null, x: -120, y: 40.5, text: "Room for the filters here" },
      { kind: "resolve", thread: "t-1", resolved: true },
      { kind: "resolve", thread: "t-1", resolved: false },
    ]);
  }
});
