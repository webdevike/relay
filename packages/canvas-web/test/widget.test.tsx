// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenUIQueryClient } from "../../protocol/src/openui/index";
import { parseEnv } from "../src/env";
import { LiveWidget, roomQueryClient } from "../src/widget";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SOURCE = `root = Card([stats, byWs, again], "Live work")
items = Query("work_items", {}, {total: 0, byWorkspace: [{name: "Loading", count: 0}]}, 30)
stats = Stat("Open items", "" + items.total)
byWs = Rows(@Each(items.byWorkspace, "w", Row(w.name, "" + w.count)))
again = Button("Refresh", Action([@Run(items)]))`;

async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	});
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("LiveWidget", () => {
	it("draws defaults, then the host's data, and refetches on @Run", async () => {
		let total = 3;
		const run = vi.fn(async () => ({ total, byWorkspace: [{ name: "ecardsystems", count: total }] }));
		const query: OpenUIQueryClient = { run };
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		act(() => root.render(<LiveWidget source={SOURCE} query={query} />));
		expect(host.textContent).toContain("Loading");
		await flush();
		expect(run).toHaveBeenCalledWith("work_items", {});
		expect(host.querySelector(".cv-w-stat-value")?.textContent).toBe("3");
		expect(host.textContent).toContain("ecardsystems");
		total = 5;
		act(() => host.querySelector<HTMLButtonElement>(".cv-w-button")?.click());
		await flush();
		expect(run).toHaveBeenCalledTimes(2);
		expect(host.querySelector(".cv-w-stat-value")?.textContent).toBe("5");
		act(() => root.unmount());
	});

	it("keeps the last data and names a failed fetch", async () => {
		const query: OpenUIQueryClient = { run: () => Promise.reject(new Error("rate limited")) };
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		act(() => root.render(<LiveWidget source={SOURCE} query={query} />));
		await flush();
		expect(host.querySelector(".cv-w-stat-value")?.textContent).toBe("0");
		expect(host.querySelector(".cv-w-issue")?.textContent).toBe("work_items: rate limited");
		act(() => root.unmount());
	});
});

describe("roomQueryClient", () => {
	it("posts to the room's token-gated query route and surfaces the host's reason", async () => {
		const env = parseEnv("http://127.0.0.1:7817/canvas/ecs-roles/?token=t1");
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ ok: true, data: { total: 2 } }));
		await expect(roomQueryClient(env).run("jobs", { name: "x" })).resolves.toEqual({ total: 2 });
		expect(fetch).toHaveBeenCalledWith("/canvas/ecs-roles/query?token=t1", expect.objectContaining({ method: "POST", body: JSON.stringify({ tool: "jobs", args: { name: "x" } }) }));
		fetch.mockResolvedValueOnce(Response.json({ ok: false, error: "unknown query tool" }, { status: 422 }));
		await expect(roomQueryClient(env).run("nope", {})).rejects.toThrow("unknown query tool");
	});
});
