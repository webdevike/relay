import { ClientMessage, MAX_RENDER_ERROR, MAX_RENDER_SRC, RENDER_REPORT_FEATURE } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import { createRenderReporter, failureText, hostTakesRenderReports, modelMarkdownError, renderFailedFrame, type RenderReport } from "./renderReport";

const report: RenderReport = {
  thread: "assistant:astra",
  message: "assistant@1762600000000",
  kind: "model",
  form: "markdown",
  src: `/drops/glb/${"ab".repeat(32)}`,
  error: modelMarkdownError("model/gltf-binary"),
};

describe("renderFailedFrame", () => {
  it("builds a render.failed frame from the phone that the host's schema accepts", () => {
    const frame = renderFailedFrame(report);
    expect(frame).toEqual({ t: "render.failed", ...report, surface: "phone" });
    expect(ClientMessage.safeParse(frame).success).toBe(true);
  });

  it("cuts src and error to the protocol's limits", () => {
    const frame = renderFailedFrame({ ...report, src: `https://x.test/${"a".repeat(3000)}`, error: "e".repeat(400) });
    expect(frame.src).toHaveLength(MAX_RENDER_SRC);
    expect(frame.error).toHaveLength(MAX_RENDER_ERROR);
    expect(ClientMessage.safeParse(frame).success).toBe(true);
  });
});

describe("hostTakesRenderReports", () => {
  it("is on only for a host that lists render.report", () => {
    expect(hostTakesRenderReports([RENDER_REPORT_FEATURE, "query"])).toBe(true);
    expect(hostTakesRenderReports(["query"])).toBe(false);
    expect(hostTakesRenderReports(undefined)).toBe(false);
  });
});

describe("createRenderReporter", () => {
  it("sends each thread, message and src once", () => {
    const sent: RenderReport[] = [];
    const reportOnce = createRenderReporter((r) => sent.push(r) > 0);
    reportOnce(report);
    reportOnce({ ...report, error: "image failed to load" });
    reportOnce({ ...report, message: "assistant@1762600000001" });
    reportOnce({ ...report, src: "https://x.test/a.glb" });
    reportOnce({ ...report, thread: "session:s1" });
    expect(sent.map((r) => `${r.thread}|${r.message}|${r.src}`)).toEqual([
      `assistant:astra|assistant@1762600000000|${report.src}`,
      `assistant:astra|assistant@1762600000001|${report.src}`,
      "assistant:astra|assistant@1762600000000|https://x.test/a.glb",
      `session:s1|assistant@1762600000000|${report.src}`,
    ]);
  });

  it("drops reports while gated off and sends them once the host takes them", () => {
    let on = false;
    const sent: RenderReport[] = [];
    const reportOnce = createRenderReporter((r) => on && sent.push(r) > 0);
    reportOnce(report);
    expect(sent).toEqual([]);
    on = true;
    reportOnce(report);
    reportOnce(report);
    expect(sent).toEqual([report]);
  });
});

describe("failureText", () => {
  it("adds the platform's reason only when it gave one", () => {
    expect(failureText("image failed to load", "HTTP 404")).toBe("image failed to load: HTTP 404");
    expect(failureText("image failed to load", "  ")).toBe("image failed to load");
    expect(failureText("video error", undefined)).toBe("video error");
  });
});
