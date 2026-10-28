import { describe, expect, it } from "vitest";
import { avatarUrl, imageUrl, parseEnv, roomUrl, wsParams, wsServer } from "../src/env";

describe("parseEnv", () => {
	it("reads slug, token and options from the host's URL", () => {
		const env = parseEnv("https://mini.ts.net/canvas/artifacts/?token=abc%2Fd&embed=phone&follow=0&theme=dark");
		expect(env).toEqual({ slug: "artifacts", token: "abc/d", embed: "phone", follow: false, theme: "dark", base: "/canvas/artifacts", origin: "https://mini.ts.net" });
	});

	it("defaults to the web embed, follow on and the system theme", () => {
		const env = parseEnv("http://127.0.0.1:7817/canvas/board-2?token=t&embed=tv&theme=sepia");
		expect(env.slug).toBe("board-2");
		expect(env.embed).toBe("web");
		expect(env.follow).toBe(true);
		expect(env.theme).toBeNull();
		expect(env.base).toBe("/canvas/board-2");
	});

	it("keeps a mount prefix in front of /canvas/<slug>", () => {
		expect(parseEnv("https://h/relay/canvas/x/?token=t").base).toBe("/relay/canvas/x");
	});
});

describe("room URLs", () => {
	const env = parseEnv("https://mini.ts.net/canvas/artifacts/?token=tok");

	it("hang every route off the room with the token", () => {
		expect(roomUrl(env, "me")).toBe("/canvas/artifacts/me?token=tok");
		expect(roomUrl(env, "end")).toBe("/canvas/artifacts/end?token=tok");
	});

	it("give y-websocket the server URL and token (it appends /ws)", () => {
		expect(wsServer(env)).toBe("wss://mini.ts.net/canvas/artifacts");
		expect(wsParams(env)).toEqual({ token: "tok" });
		expect(wsServer(parseEnv("http://127.0.0.1:7817/canvas/a/"))).toBe("ws://127.0.0.1:7817/canvas/a");
		expect(wsParams(parseEnv("http://127.0.0.1:7817/canvas/a/"))).toEqual({});
	});

	it("load remote images directly and board files through the img route", () => {
		expect(imageUrl(env, "https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
		expect(imageUrl(env, "/Users/ike/Pictures/a b.png")).toBe("/canvas/artifacts/img?token=tok&src=%2FUsers%2Fike%2FPictures%2Fa+b.png");
	});

	it("use host avatar paths as they are", () => {
		expect(avatarUrl(env, "/canvas/avatar/nova")).toBe("/canvas/avatar/nova");
		expect(avatarUrl(env, "img/avatar.png")).toBe("/canvas/artifacts/img/avatar.png");
	});
});
