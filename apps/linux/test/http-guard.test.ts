import { describe, expect, it } from "vitest";
import { guardWrite } from "../src/http-guard";
import { loopbackWriteBody } from "../src/server";

const TOKEN = "a".repeat(64);

interface Route {
  readonly method: string;
  readonly path: string;
  /** The content type the route's own client sends. */
  readonly type: string;
}

const JSON_TYPE = "application/json";
const ROUTES: readonly Route[] = [
  { method: "POST", path: "/drops", type: "text/plain; charset=utf-8" },
  { method: "POST", path: "/assistant/say", type: "text/plain; charset=utf-8" },
  { method: "POST", path: "/assistant/asks", type: JSON_TYPE },
  { method: "POST", path: "/assistant/asks/resolve", type: JSON_TYPE },
  { method: "POST", path: "/assistant/registry", type: JSON_TYPE },
  { method: "PATCH", path: "/assistant/registry/nova", type: JSON_TYPE },
  { method: "POST", path: "/catchup/bounce", type: JSON_TYPE },
  { method: "POST", path: "/reactions/agent", type: JSON_TYPE },
  { method: "PUT", path: "/boards/today", type: JSON_TYPE },
  { method: "POST", path: "/boards/today/ops", type: JSON_TYPE },
  { method: "POST", path: "/skills/review/save", type: JSON_TYPE },
  { method: "POST", path: "/canvas/sessions", type: JSON_TYPE },
  { method: "POST", path: "/canvas/sessions/room/end", type: JSON_TYPE },
  { method: "POST", path: "/query", type: JSON_TYPE },
  { method: "POST", path: "/control/run", type: JSON_TYPE },
];

function attempt(route: Route, init: { token?: string | null; origin?: string; referer?: string; type?: string; host?: string; remote?: string } = {}): Response | null {
  const headers = new Headers({ "content-type": init.type ?? route.type });
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (init.origin !== undefined) headers.set("origin", init.origin);
  if (init.referer !== undefined) headers.set("referer", init.referer);
  const request = new Request(`http://${init.host ?? "127.0.0.1:7817"}${route.path}`, { method: route.method, headers, body: "x" });
  const body = loopbackWriteBody(route.path);
  expect(body).not.toBeNull();
  return guardWrite(request, init.remote ?? "127.0.0.1", TOKEN, body ?? "json");
}

describe.each(ROUTES)("$method $path", (route) => {
  it("lets the host's token through", () => {
    expect(attempt(route)).toBeNull();
    expect(attempt(route, { origin: "http://127.0.0.1:7817" })).toBeNull();
  });

  it("refuses a request without the token or with a wrong one: 401", () => {
    expect(attempt(route, { token: null })?.status).toBe(401);
    expect(attempt(route, { token: "b".repeat(64) })?.status).toBe(401);
    expect(attempt(route, { token: "" })?.status).toBe(401);
  });

  it("refuses another site's Origin or Referer, with or without the token: 403", () => {
    for (const token of [TOKEN, null]) {
      expect(attempt(route, { token, origin: "https://evil.example" })?.status).toBe(403);
      expect(attempt(route, { token, referer: "https://evil.example/page" })?.status).toBe(403);
      expect(attempt(route, { token, origin: "null" })?.status).toBe(403);
    }
  });

  it("refuses a non-loopback peer or Host: 403", () => {
    expect(attempt(route, { remote: "192.168.1.9" })?.status).toBe(403);
    expect(attempt(route, { host: "rebind.example:7817", origin: "http://rebind.example:7817" })?.status).toBe(403);
  });

  it("refuses form posts: 415", () => {
    expect(attempt(route, { type: "application/x-www-form-urlencoded" })?.status).toBe(415);
    expect(attempt(route, { type: "multipart/form-data; boundary=x" })?.status).toBe(415);
  });
});

describe("content types", () => {
  it("JSON routes refuse text/plain, the no-preflight type a web page can send", () => {
    for (const route of ROUTES.filter((candidate) => loopbackWriteBody(candidate.path) === "json"))
      expect(attempt(route, { type: "text/plain" })?.status).toBe(415);
  });

  it("the say route takes text/plain only; drops take bytes", () => {
    const say = ROUTES.find((route) => route.path === "/assistant/say");
    const drops = ROUTES.find((route) => route.path === "/drops");
    if (say === undefined || drops === undefined) throw new Error("routes missing");
    expect(attempt(say, { type: JSON_TYPE })?.status).toBe(415);
    expect(attempt(drops, { type: "image/png" })).toBeNull();
  });

  it("a DELETE has no body, so no type", () => {
    const request = new Request("http://127.0.0.1:7817/assistant/registry/nova", { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(guardWrite(request, "127.0.0.1", TOKEN, "json")).toBeNull();
  });
});

describe("which routes are guarded", () => {
  it("leaves device sockets, tokened rooms and blobs to their own checks", () => {
    for (const path of ["/relay", "/canvas/room/end", "/canvas/room/query", "/artifacts/media/abc/tok", "/studio/x", "/meetings/ingest"])
      expect(loopbackWriteBody(path)).toBeNull();
  });
});
