import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_UNSORTED, studioItems, type StudioOp, type StudioResult } from "@relay/protocol";
import { useStudioStore } from "@/state/studio";
import { deleteImages, favoriteAssets, moveAssets, trashAssets, useStudioToast } from "./actions";
import { EMPTY_CREATE } from "./create";
import { job, project } from "./fixtures";
import { ALL_VIEW } from "./library";

const sent: StudioOp[] = [];
let answer: StudioResult = { rid: "r", ok: true };
const requestStudio = vi.fn();
const confirmDelete = vi.fn<(total: number, selected: number) => Promise<boolean>>();

vi.mock("./confirm", () => ({ confirmDelete: (total: number, selected: number) => confirmDelete(total, selected) }));

vi.mock("@/connection", () => ({
  studioRequest: (op: StudioOp) => {
    sent.push(op);
    return Promise.resolve(answer);
  },
  requestStudio: () => {
    requestStudio();
  },
}));

const live = () => studioItems(useStudioStore.getState().jobs).map((item) => item.asset.id);
const projectOf = (id: string) => useStudioStore.getState().jobs.find((j) => j.id === id)?.project;

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  answer = { rid: "r", ok: true };
  requestStudio.mockClear();
  useStudioToast.getState().clear();
  useStudioStore.setState({ loaded: true, jobs: [job("c", 3), job("b", 2, { project: "p" }), job("a", 1)], backends: [], projects: [project("p", "Portraits", 1), project("q", "Products", 2)], references: [], segments: {}, view: ALL_VIEW, create: EMPTY_CREATE });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("trash with Undo", () => {
  it("hides the selection at once, sends trash, and Undo sends restore and brings it back", async () => {
    await trashAssets(["ao", "co"]);
    expect(live()).toEqual(["bo"]);
    expect(sent).toEqual([{ kind: "trash", assets: ["ao", "co"] }]);
    const toast = useStudioToast.getState().toast;
    expect(toast?.text).toBe("Deleted 2 images");
    expect(toast?.action?.label).toBe("Undo");

    toast?.action?.run();
    expect(live()).toEqual(["co", "bo", "ao"]);
    await vi.runAllTimersAsync();
    expect(sent.at(-1)).toEqual({ kind: "restore", assets: ["ao", "co"] });
  });

  it("the Undo toast goes after a while", async () => {
    await trashAssets(["ao"]);
    vi.advanceTimersByTime(6000);
    expect(useStudioToast.getState().toast).toBeNull();
  });

  it("a refusal asks for the library again and says why", async () => {
    answer = { rid: "r", ok: false, error: "Trash is full" };
    await trashAssets(["ao"]);
    expect(requestStudio).toHaveBeenCalledTimes(1);
    expect(useStudioToast.getState().toast?.text).toBe("Trash is full");
  });
});

describe("favoriteAssets", () => {
  it("marks them at once and sends one favorite op", async () => {
    await favoriteAssets(["ao", "bo"], true);
    expect(useStudioStore.getState().jobs.flatMap((j) => j.outputs.filter((o) => o.favorite === true).map((o) => o.id))).toEqual(["bo", "ao"]);
    expect(sent).toEqual([{ kind: "favorite", assets: ["ao", "bo"], value: true }]);
  });
});

describe("moveAssets with Undo", () => {
  it("moves at once, and Undo moves each back to where it was", async () => {
    await moveAssets(["ao", "bo"], "q");
    expect([projectOf("a"), projectOf("b")]).toEqual(["q", "q"]);
    expect(sent).toEqual([{ kind: "move", assets: ["ao", "bo"], project: "q" }]);
    expect(useStudioToast.getState().toast?.text).toBe("Moved 2 images to Products");

    useStudioToast.getState().toast?.action?.run();
    expect([projectOf("a"), projectOf("b")]).toEqual([undefined, "p"]);
    expect(sent.slice(1)).toEqual([
      { kind: "move", assets: ["ao"], project: STUDIO_UNSORTED },
      { kind: "move", assets: ["bo"], project: "p" },
    ]);
  });

  it("does nothing when they are already there", async () => {
    await moveAssets(["bo"], "p");
    expect(sent).toEqual([]);
  });
});

describe("deleteImages", () => {
  const family = () => {
    // a <- a2 <- a3 (edits of edits), b alone.
    useStudioStore.setState({
      jobs: [
        job("a3", 5, { parent: { asset: "a2o", how: "edit" } }),
        job("a2", 4, { parent: { asset: "ao", how: "edit" } }),
        job("b", 3),
        job("a", 1),
      ],
    });
  };

  it("takes the original and every version made from it, after one confirm that counts them all", async () => {
    family();
    confirmDelete.mockResolvedValue(true);
    expect(await deleteImages(["ao"])).toBe(true);
    expect(confirmDelete).toHaveBeenCalledWith(3, 1);
    expect(sent).toEqual([{ kind: "trash", assets: ["ao", "a2o", "a3o"] }]);
    expect(live()).toEqual(["bo"]);
  });

  it("a version takes only its own edits; two selected originals are counted together", async () => {
    family();
    confirmDelete.mockResolvedValue(true);
    await deleteImages(["a2o"]);
    expect(sent).toEqual([{ kind: "trash", assets: ["a2o", "a3o"] }]);
    sent.length = 0;
    family();
    await deleteImages(["ao", "bo"]);
    expect(confirmDelete).toHaveBeenLastCalledWith(4, 2);
    expect(sent).toEqual([{ kind: "trash", assets: ["ao", "a2o", "a3o", "bo"] }]);
  });

  it("sends nothing when Isaac cancels", async () => {
    family();
    confirmDelete.mockResolvedValue(false);
    expect(await deleteImages(["ao"])).toBe(false);
    expect(sent).toEqual([]);
    expect(live()).toContain("ao");
  });
});
