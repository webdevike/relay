import { describe, expect, it, vi } from "vitest";
import { type EmbedTarget, postEmbed } from "../src/embed";

describe("postEmbed", () => {
	it("posts the event object to an iframe parent", () => {
		const parent = { postMessage: vi.fn() };
		postEmbed({ parent }, { type: "canvas.ready", slug: "artifacts" });
		expect(parent.postMessage).toHaveBeenCalledWith({ type: "canvas.ready", slug: "artifacts" }, "*");
	});

	it("posts JSON to the phone's WebView, not to itself as parent", () => {
		const post = vi.fn();
		const rn = { postMessage: vi.fn() };
		const win: EmbedTarget = { parent: null, ReactNativeWebView: rn };
		win.parent = Object.assign(win, { postMessage: post });
		postEmbed(win, { type: "canvas.ended", slug: "a", summary: "Done." });
		expect(rn.postMessage).toHaveBeenCalledWith('{"type":"canvas.ended","slug":"a","summary":"Done."}');
		expect(post).not.toHaveBeenCalled();
	});
});
