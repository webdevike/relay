import { describe, expect, it } from "vitest";
import type { Presence } from "../../canvas-live/src/shared";
import { beginLoad, describeActivity } from "../src/activity";

const nova = (p: Partial<Presence> = {}): Presence => ({ user: { name: "Nova", color: "#8b5cf6", kind: "agent", avatar: "/canvas/avatar/nova" }, status: "idle", ...p });
const isaac: Presence = { user: { name: "Isaac", color: "#fa5252", kind: "human" } };
const describeOf = (presences: Presence[], added = 0, widgetsLoading = 0) => describeActivity({ presences, added, widgetsLoading });

describe("describeActivity", () => {
	it("is hidden when everyone is idle", () => {
		expect(describeOf([nova(), isaac])).toBeNull();
	});

	it("says what the agent is doing, with the animated dot while it works", () => {
		expect(describeOf([nova({ status: "thinking" })])).toMatchObject({ text: "Nova is thinking…", working: true, avatar: "/canvas/avatar/nova" });
		expect(describeOf([nova({ status: "typing" })])?.text).toBe("Nova is working…");
		expect(describeOf([nova({ status: "drawing" })])?.text).toBe("Nova is connecting cards");
		expect(describeOf([nova({ status: "typing" })], 1)?.text).toBe("Nova is adding a card");
		expect(describeOf([nova({ status: "typing" })], 3)?.text).toBe("Nova is adding 3 cards");
	});

	it("names a handoff the agent is waiting on, without the working dot", () => {
		expect(describeOf([nova({ task: "screenshots" })])).toMatchObject({ text: "Waiting on Nova: screenshots (handoff)", working: false });
		expect(describeOf([nova({ task: "x".repeat(200) })])?.text.length).toBeLessThan(90);
	});

	it("prefers acting over waiting, and shows widgets only when no agent has anything to say", () => {
		expect(describeOf([nova({ task: "screenshots", status: "thinking" })])?.text).toBe("Nova is thinking…");
		expect(describeOf([nova()], 0, 2)).toMatchObject({ text: "Live widgets refreshing", working: true });
		expect(describeOf([nova({ status: "thinking" })], 0, 2)?.text).toBe("Nova is thinking…");
	});
});

describe("beginLoad", () => {
	it("ends a load once, however often the end is called", () => {
		const a = beginLoad("card-1");
		const b = beginLoad("card-1");
		a();
		a();
		b();
		// No throw and nothing left open: a fresh pair behaves the same.
		const c = beginLoad("card-1");
		c();
	});
});
