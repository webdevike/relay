import { describe, expect, it } from "vitest";
import { imageSources, rewriteImages } from "../src/markdown-images";
import signedImages from "../fixtures/signed-images.json";

const SIGNED = "https://private-user-images.githubusercontent.com/1/x.png?jwt=SECRETJWT";
const LOCAL = "/reviews/media/local.png";
/** The private URL to its local copy; everything else kept. */
const map = (url: string): string | undefined => (url === SIGNED ? LOCAL : undefined);

describe("markdown images", () => {
  it.each([
    ["no title", `![a](${SIGNED})`, `![a](${LOCAL})`],
    ["an angle-bracket source", `![a](<${SIGNED}>)`, `![a](${LOCAL})`],
    ["a double-quoted title", `![a](${SIGNED} "The \\"shot\\"")`, `![a](${LOCAL} "The 'shot'")`],
    ["a single-quoted title", `![a](${SIGNED} 'title')`, `![a](${LOCAL} "title")`],
    ["a parenthesized title", `![a](${SIGNED} (title))`, `![a](${LOCAL} "title")`],
    ["a title on the next line", `![a](${SIGNED}\n  'title')`, `![a](${LOCAL} "title")`],
    ["an `<img>` tag", `<img width="320" alt='a' src="${SIGNED}">`, `![a](${LOCAL} "w=320")`],
    ["an unquoted `<img>` tag", `<IMG SRC=${SIGNED} alt=a title="t >">`, `![a](${LOCAL} "t >")`],
    ["a linked image repeating its source", `[![a](${SIGNED} "t")](${SIGNED})`, `![a](${LOCAL} "t")`],
    ["a linked image with an angle-bracket destination", `[![a](${SIGNED})](<${SIGNED}>)`, `![a](${LOCAL})`],
    ["a linked `<img>`", `[<img src="${SIGNED}" alt="a">](${SIGNED} 'go')`, `![a](${LOCAL})`],
    ["an `<a href>` around an `<img>`", `<a target="_blank" href="${SIGNED}"><img src="${SIGNED}" alt="a"></a>`, `![a](${LOCAL})`],
    ["an `<a href>` around a markdown image", `<a href='${SIGNED}'>\n![a](${SIGNED})\n</a>`, `![a](${LOCAL})`],
    ["a reference definition", `![a][shot]\n\n[shot]: <${SIGNED}> "t"`, `![a][shot]\n\n[shot]: ${LOCAL} "t"`],
  ])("rewrites %s and leaves no signature", (_, md, expected) => {
    const out = rewriteImages(md, map);
    expect(out).toBe(expected);
    expect(out).not.toContain("SECRETJWT");
    expect(imageSources(md)).toEqual([SIGNED]);
  });

  it.each(Object.entries(signedImages.forms))("lists and rewrites the shared fixture's %s", (_, md) => {
    expect(imageSources(md)).toEqual([signedImages.signed]);
    const out = rewriteImages(md, (url) => (url === signedImages.signed ? LOCAL : undefined));
    expect(out).toContain(LOCAL);
    for (const secret of signedImages.secrets) expect(out).not.toContain(secret);
  });

  it("keeps a public link around a private image, and an `<a href>` becomes a markdown link", () => {
    const md = [
      `[![a](${SIGNED})](https://example.com/pr "PR")`,
      `<a href="https://example.com/x"><img src="${SIGNED}" width=40></a>`,
      `<a><img src="${SIGNED}"></a>`,
    ].join("\n\n");
    expect(rewriteImages(md, map).split("\n\n")).toEqual([
      `[![a](${LOCAL})](https://example.com/pr "PR")`,
      `[![](${LOCAL} "w=40")](https://example.com/x)`,
      `![](${LOCAL})`,
    ]);
  });

  it("drops a private link around a public image, and a private link around an `<img>` without a source", () => {
    expect(rewriteImages(`[![a](https://example.com/a.png)](${SIGNED})`, map)).toBe("![a](https://example.com/a.png)");
    expect(rewriteImages(`<a href="${SIGNED}"><img alt="x"></a>`, map)).toBe("");
    expect(imageSources(`[![a](https://example.com/a.png)](${SIGNED})`)).toEqual(["https://example.com/a.png"]);
  });

  it("leaves public images' URLs, other links and definitions alone, and `<img>` tags without a source", () => {
    const md = [
      "![wide](https://example.com/a_(b).png)",
      "![sp](<https://example.com/a b.png>)",
      "[a link](https://example.com/page)",
      "[ref]: https://example.com/r.png",
      '<img alt="none">',
      "![esc \\[1\\]](https://example.com/e.png)",
    ].join("\n\n");
    expect(rewriteImages(md, map).split("\n\n")).toEqual([
      "![wide](<https://example.com/a_(b).png>)",
      "![sp](<https://example.com/a b.png>)",
      "[a link](https://example.com/page)",
      "[ref]: https://example.com/r.png",
      '<img alt="none">',
      "![esc 1](https://example.com/e.png)",
    ]);
    expect(imageSources(md)).toEqual([
      "https://example.com/a_(b).png",
      "https://example.com/a b.png",
      "https://example.com/r.png",
      "https://example.com/e.png",
    ]);
  });

  it("encodes an `<img>` width as `w=N`, `w=N Title` with a title, from its style too", () => {
    const md = [
      '<img width=400 src=https://example.com/a.png alt=wide>',
      '<img style="max-width: 90%; width: 320px" src="https://example.com/b.png">',
      '<img width="50%" src="https://example.com/f.png">',
      '<img width="320" title="Login" src="https://example.com/g.png">',
    ].join("\n\n");
    expect(rewriteImages(md, () => undefined).split("\n\n")).toEqual([
      '![wide](https://example.com/a.png "w=400")',
      '![](https://example.com/b.png "w=320")',
      "![](https://example.com/f.png)",
      '![](https://example.com/g.png "w=320 Login")',
    ]);
  });
});
