import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewMedia } from "../src/reviews/linear";
import {
  fetchMedia,
  isGithubUpload,
  isLinearUpload,
  localizeImages,
  redactUrl,
  slackFetchScript,
  slackImage,
  UNAVAILABLE_MEDIA,
} from "../src/reviews/media";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A failed private image: the placeholder with its alt and title, its URL nowhere in the output. */
function expectUnavailable(out: string, expected: string, ...secrets: string[]): void {
  expect(out).toBe(expected);
  for (const secret of secrets) expect(JSON.stringify(out)).not.toContain(secret);
}

describe("review media", () => {
  // The host's config dir may have spaces; markdown only ever carries the host path.
  const media = new ReviewMedia(join(mkdtempSync(join(tmpdir(), "relay reviews ")), "media"));

  it("downloads GitHub and Linear images with their auth, `<img>` tags too, and points at the host", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({
        url,
        auth: (init?.headers as Record<string, string> | undefined)?.["authorization"],
      });
      return Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } }));
    };
    const gh = "https://github.com/user-attachments/assets/0e9e";
    const md = `<img width="2900" alt="pair [1440]" src="${gh}" />\n\n![shot one.png](https://uploads.linear.app/a/b?signature=x)\n\n![public](https://example.com/a.png)`;
    const out = await localizeImages(
      md,
      media,
      [
        { match: isGithubUpload, headers: () => Promise.resolve({ authorization: "token T" }) },
        { match: isLinearUpload, headers: () => Promise.resolve({ authorization: "lin" }) },
      ],
      fetchFn,
    );
    const lines = out.split("\n\n");
    expect(lines[0]).toMatch(
      /^!\[pair 1440\]\(\/reviews\/media\/[0-9a-f]{40}\.png\/[0-9a-f]{32} "w=2900"\)$/,
    );
    expect(lines[1]).toMatch(
      /^!\[shot one\.png\]\(\/reviews\/media\/[0-9a-f]{40}\.png\/[0-9a-f]{32}\)$/,
    );
    expect(lines[2]).toBe("![public](https://example.com/a.png)");
    expect(seen).toEqual([
      { url: gh, auth: "token T" },
      { url: "https://uploads.linear.app/a/b?signature=x", auth: "lin" },
    ]);
    const [, name, token] = /\/reviews\/media\/([^/]+)\/([0-9a-f]+) /.exec(lines[0] ?? "") ?? [];
    const blob = media.open(name ?? "", token ?? "");
    expect(blob?.mimeType).toBe("image/png");
    expect(readFileSync(blob?.path ?? "")).toEqual(Buffer.from(PNG));
  });

  it("points a failed download at the unavailable placeholder", async () => {
    const out = await localizeImages(
      '<img src="https://github.com/user-attachments/assets/gone">',
      media,
      [{ match: isGithubUpload, headers: () => Promise.resolve({}) }],
      () => Promise.resolve(new Response("no", { status: 404 })),
    );
    expectUnavailable(out, `![](${UNAVAILABLE_MEDIA})`, "assets/gone");
  });

  it("keeps titles, turns an `<img>` width into `w=N` (`w=N <title>` with a title too), and leaves other images as they are", async () => {
    const md = [
      "<img width=400 src=https://example.com/a.png alt=wide>",
      '<img style="max-width: 90%; width: 320px" src="https://example.com/b.png">',
      "<img title='A \"quoted\" one' src='https://example.com/c.png'>",
      '![sized](https://example.com/d.png "w=250")',
      '![titled](<https://example.com/e.png> "The shot")',
      '<img width="50%" src="https://example.com/f.png">',
      '<img width="320" title="Login" src="https://example.com/g.png">',
    ].join("\n\n");
    const out = await localizeImages(md, media, [], () => Promise.reject(new Error("no fetch")));
    expect(out.split("\n\n")).toEqual([
      '![wide](https://example.com/a.png "w=400")',
      '![](https://example.com/b.png "w=320")',
      "![](https://example.com/c.png \"A 'quoted' one\")",
      '![sized](https://example.com/d.png "w=250")',
      '![titled](https://example.com/e.png "The shot")',
      "![](https://example.com/f.png)",
      '![](https://example.com/g.png "w=320 Login")',
    ]);
  });

  it("follows a user-attachments redirect to GitHub's private images without the token, and never sends Linear's key to GitHub", async () => {
    const seen: { url: string; auth: string | undefined; redirect: string | undefined }[] = [];
    const gh = "https://github.com/user-attachments/assets/redirected";
    const signed = "https://private-user-images.githubusercontent.com/1/shot.png?jwt=SECRET.JWT";
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({
        url,
        auth: (init?.headers as Record<string, string> | undefined)?.["authorization"],
        redirect: init?.redirect,
      });
      if (url === signed)
        return Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } }));
      return Promise.resolve(new Response(null, { status: 302, headers: { location: signed } }));
    };
    const lin = "https://uploads.linear.app/x/redirects";
    const out = await localizeImages(
      `![a](${gh} "w=400")\n\n![b](${lin})`,
      media,
      [
        { match: isGithubUpload, headers: () => Promise.resolve({ authorization: "token T" }) },
        { match: isLinearUpload, headers: () => Promise.resolve({ authorization: "lin" }) },
      ],
      fetchFn,
    );
    expect(out).toMatch(
      /^!\[a\]\(\/reviews\/media\/[0-9a-f]{40}\.png\/[0-9a-f]{32} "w=400"\)\n\n!\[b\]\(\/reviews\/media\//,
    );
    expect(seen).toHaveLength(4);
    expect(seen).toEqual(
      expect.arrayContaining([
        { url: gh, auth: "token T", redirect: "manual" },
        { url: lin, auth: "lin", redirect: "manual" },
        { url: signed, auth: undefined, redirect: "manual" },
      ]),
    );
    expect(seen.filter((s) => s.url === signed).map((s) => s.auth)).toEqual([undefined, undefined]);
  });

  it("refuses a redirect to a host off the allowlist, and too many redirects, showing the placeholder", async () => {
    const seen: string[] = [];
    const gh = "https://github.com/user-attachments/assets/evil";
    const fetchFn = (url: string): Promise<Response> => {
      seen.push(url);
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal?jwt=SECRET" },
        }),
      );
    };
    const out = await localizeImages(
      `![x](${gh} "Proof")`,
      media,
      [{ match: isGithubUpload, headers: () => Promise.resolve({ authorization: "token T" }) }],
      fetchFn,
    );
    expectUnavailable(out, `![x](${UNAVAILABLE_MEDIA} "Proof")`, gh, "SECRET");
    expect(seen).toEqual([gh]);
    await expect(fetchMedia(gh, {}, fetchFn)).rejects.toThrow("not allowed");

    const loop = "https://github.com/user-attachments/assets/loop";
    const looping = (url: string): Promise<Response> => {
      seen.push(url);
      return Promise.resolve(new Response(null, { status: 307, headers: { location: loop } }));
    };
    seen.length = 0;
    await expect(fetchMedia(loop, {}, looping)).rejects.toThrow("Too many redirects");
    expect(seen).toHaveLength(4);
  });

  it("fetches a private-user-images JWT URL with gh's token; an expired, timed out or failing one is the placeholder and the JWT stays out of output and errors", async () => {
    const jwt = "https://private-user-images.githubusercontent.com/9/expired.png?jwt=eyJSECRET";
    const auths: (string | undefined)[] = [];
    const expired = (_url: string, init?: RequestInit): Promise<Response> => {
      auths.push((init?.headers as Record<string, string> | undefined)?.["authorization"]);
      return Promise.resolve(new Response("expired", { status: 403 }));
    };
    const md = `<img width="400" alt="proof" src="${jwt}">`;
    const sources = [
      { match: isGithubUpload, headers: () => Promise.resolve({ authorization: "token T" }) },
    ];
    const failing: ((url: string, init?: RequestInit) => Promise<Response>)[] = [
      expired,
      () => Promise.resolve(new Response("unauthorized", { status: 401 })),
      () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      () => Promise.reject(new Error(`boom ${jwt}`)),
    ];
    for (const fetchFn of failing)
      expectUnavailable(
        await localizeImages(md, media, sources, fetchFn),
        `![proof](${UNAVAILABLE_MEDIA} "w=400")`,
        "eyJSECRET",
        "jwt=",
        "private-user-images",
      );
    expect(auths).toEqual(["token T"]);
    const errors = await Promise.all([
      fetchMedia(jwt, {}, expired).catch((e: unknown) => String(e)),
      fetchMedia(jwt, {}, () => Promise.reject(new Error(`boom ${jwt}`))).catch((e: unknown) =>
        String(e),
      ),
    ]);
    expect(errors).toEqual([
      "Error: https://private-user-images.githubusercontent.com/9/expired.png answered 403",
      "Error: Couldn't fetch https://private-user-images.githubusercontent.com/9/expired.png",
    ]);
    expect(errors.join()).not.toContain("SECRET");
    expect(redactUrl(jwt)).toBe("https://private-user-images.githubusercontent.com/9/expired.png");
  });

  it("refuses images over 10 MB, announced or streamed", async () => {
    const MB = 1024 * 1024;
    const announced = (): Promise<Response> =>
      Promise.resolve(
        new Response(PNG, {
          headers: { "content-type": "image/png", "content-length": String(11 * MB) },
        }),
      );
    await expect(fetchMedia("https://uploads.linear.app/big", {}, announced)).rejects.toThrow(
      "over 10 MB",
    );
    let pulled = 0;
    const streamed = (): Promise<Response> =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (c) => {
              pulled += 1;
              c.enqueue(new Uint8Array(MB));
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
      );
    const url = "https://uploads.linear.app/endless";
    expect(
      await localizeImages(
        `![big](${url})`,
        media,
        [{ match: isLinearUpload, headers: () => Promise.resolve({}) }],
        streamed,
      ),
    ).toBe(`![big](${UNAVAILABLE_MEDIA})`);
    expect(pulled).toBeLessThan(13);
    expect(isGithubUpload("https://github.com.evil.example/user-attachments/assets/x")).toBe(false);
    expect(isGithubUpload("https://github.com/other/assets/x")).toBe(false);
    expect(isLinearUpload("https://uploads.linear.app:8443/x")).toBe(false);
    expect(isLinearUpload("http://uploads.linear.app/x")).toBe(false);
  });

  it("keeps the media dir within its bound, oldest first, and downloads an evicted image again", async () => {
    let fetched = 0;
    const fetchFn = (): Promise<Response> => {
      fetched += 1;
      return Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } }));
    };
    const file = (name: string): string =>
      `${createHash("sha1").update(`https://uploads.linear.app/${name}`).digest("hex")}.png`;
    const get = (m: ReviewMedia, name: string): Promise<string> =>
      localizeImages(
        `![](https://uploads.linear.app/${name})`,
        m,
        [{ match: isLinearUpload, headers: () => Promise.resolve({}) }],
        fetchFn,
      );
    const age = (m: ReviewMedia, name: string, seconds: number): void => {
      const t = Date.now() / 1000 - seconds;
      utimesSync(join(m.dir, file(name)), t, t);
    };

    const byCount = new ReviewMedia(join(mkdtempSync(join(tmpdir(), "relay-bound-")), "media"), {
      files: 2,
      bytes: 1e9,
    });
    const a = await get(byCount, "a");
    age(byCount, "a", 300);
    await get(byCount, "b");
    age(byCount, "b", 200);
    await get(byCount, "c");
    expect(readdirSync(byCount.dir).sort()).toEqual([file("b"), file("c")].sort());
    // Its served path no longer opens; the next render downloads it again (a missing file is not cached).
    const [, name, token] = /\/reviews\/media\/([^/]+)\/([0-9a-f]+)/.exec(a) ?? [];
    expect(byCount.open(name ?? "", token ?? "")).toBeNull();
    expect(await get(byCount, "a")).toBe(a);
    expect(fetched).toBe(4);
    expect(existsSync(join(byCount.dir, file("a")))).toBe(true);
    expect(existsSync(join(byCount.dir, file("b")))).toBe(false);

    const byBytes = new ReviewMedia(join(mkdtempSync(join(tmpdir(), "relay-bound-")), "media"), {
      files: 100,
      bytes: 10,
    });
    await get(byBytes, "x");
    age(byBytes, "x", 300);
    await get(byBytes, "y");
    age(byBytes, "y", 200);
    await get(byBytes, "z");
    expect(readdirSync(byBytes.dir).sort()).toEqual([file("y"), file("z")].sort());
  });

  it("reads Slack files only through files.info, and gives up when Slack's port is closed", async () => {
    const script = slackFetchScript("F0CCWMUPTK7");
    expect(script).toContain("'/api/files.info'");
    expect(script).not.toMatch(/chat\.postMessage|location\s*=|\.click\(|keyboard|dispatchEvent/);
    expect(await slackImage("F1", media, "http://127.0.0.1:9")).toBeNull();
  });
});
