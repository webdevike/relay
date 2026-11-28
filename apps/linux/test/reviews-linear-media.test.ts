import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Linear, ReviewMedia } from "../src/reviews/linear";
import { UNAVAILABLE_MEDIA } from "../src/reviews/media";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GRAPHQL = "https://api.linear.app/graphql";
const DESCRIBED = "https://uploads.linear.app/ws/desc/shot.png?signature=DESCSECRET";
const COMMENTED = "https://uploads.linear.app/ws/comment/shot.png?signature=COMMENTSECRET";
const me = { id: "u1", name: "Isaac", displayName: "ike", url: "https://linear.app/ws/profiles/ike" };

/** One ticket whose description and comment carry Linear's private uploads, as GraphQL answers it. */
const ticket = {
  data: {
    viewer: me,
    issue: {
      id: "i1",
      identifier: "ENG-7",
      title: "Login",
      url: "https://linear.app/ws/issue/ENG-7",
      description: `Broken:\n\n![desc shot](${DESCRIBED})`,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-02T00:00:00Z",
      priorityLabel: "High",
      creator: me,
      state: { name: "Todo", type: "unstarted", color: "#fff" },
      assignee: null,
      team: { name: "Eng" },
      labels: { nodes: [] },
      project: null,
      parent: null,
      children: { nodes: [] },
      attachments: { nodes: [] },
      comments: {
        nodes: [
          {
            id: "c1",
            body: `<img width="320" alt="comment shot" src="${COMMENTED}">`,
            createdAt: "2026-11-01T01:00:00Z",
            url: "https://linear.app/ws/issue/ENG-7#comment-c1",
            user: me,
            parent: null,
          },
        ],
      },
      history: { nodes: [] },
    },
  },
};

/** A Linear client whose GraphQL answers `ticket` and whose uploads answer `upload`. */
function linear(upload: () => Promise<Response>): {
  client: Linear;
  seen: { url: string; auth: string | undefined }[];
} {
  const seen: { url: string; auth: string | undefined }[] = [];
  const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
    if (url === GRAPHQL) return Promise.resolve(Response.json(ticket));
    seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] });
    return upload();
  };
  const media = new ReviewMedia(join(mkdtempSync(join(tmpdir(), "relay linear media ")), "media"));
  return { client: new Linear(() => "lin_key", media, fetchFn), seen };
}

describe("Linear ticket media", () => {
  it("downloads description and comment uploads with the key, sent only to uploads.linear.app", async () => {
    const { client, seen } = linear(() =>
      Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } })),
    );
    const t = await client.ticket("ENG-7");
    expect(t.description).toMatch(
      /^Broken:\n\n!\[desc shot\]\(\/reviews\/media\/[0-9a-f]{40}\.png\/[0-9a-f]{32}\)$/,
    );
    expect(t.comments[0]?.body).toMatch(
      /^!\[comment shot\]\(\/reviews\/media\/[0-9a-f]{40}\.png\/[0-9a-f]{32} "w=320"\)$/,
    );
    expect(seen.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: COMMENTED, auth: "lin_key" },
      { url: DESCRIBED, auth: "lin_key" },
    ]);
    expect(JSON.stringify(t)).not.toContain("uploads.linear.app");
  });

  it("shows the unavailable placeholder when an upload refuses the key, never its signed URL", async () => {
    const { client } = linear(() => Promise.resolve(new Response("no", { status: 401 })));
    const t = await client.ticket("ENG-7");
    expect(t.description).toBe(`Broken:\n\n![desc shot](${UNAVAILABLE_MEDIA})`);
    expect(t.comments[0]?.body).toBe(`![comment shot](${UNAVAILABLE_MEDIA} "w=320")`);
    const out = JSON.stringify(t);
    for (const secret of ["uploads.linear.app", "SECRET", "signature="])
      expect(out).not.toContain(secret);
  });
});
