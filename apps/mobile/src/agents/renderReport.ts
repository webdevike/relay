/**
 * The plain parts of render reports (`RenderReport.tsx` holds the React side): when media an
 * assistant posted fails to show on the phone, the phone tells the host once per bubble and src
 * (`render.failed`), and the host tells the owning agent so it reposts a form that works. Kept free
 * of React Native so vitest can run it.
 */
import { renderFailure, RENDER_REPORT_FEATURE, type RenderFailure } from "@relay/protocol";

/** A report as the media element knows it; the connection adds the surface. */
export type RenderReport = Omit<RenderFailure, "surface">;

/** Whether this host takes `render.failed` frames: an older one drops the socket on unknown frames. */
export function hostTakesRenderReports(features: readonly string[] | undefined): boolean {
  return features?.includes(RENDER_REPORT_FEATURE) === true;
}

/** The wire frame for one report, cut to the protocol's limits. */
export function renderFailedFrame(report: RenderReport): RenderFailure & { t: "render.failed" } {
  return { t: "render.failed", ...renderFailure({ ...report, surface: "phone" }) };
}

/** One report per bubble and src per app run, however often the element remounts or retries. */
export function renderReportKey(report: Pick<RenderReport, "thread" | "message" | "src">): string {
  return `${report.thread}|${report.message}|${report.src}`;
}

/**
 * Deduping front for `send`, which answers whether the frame went out. A report that could not be
 * sent (offline, or a host without the feature) is not remembered, so the next failure of the same
 * src after a reconnect still reaches the host.
 */
export function createRenderReporter(send: (report: RenderReport) => boolean): (report: RenderReport) => void {
  const sent = new Set<string>();
  return (report) => {
    const key = renderReportKey(report);
    if (sent.has(key)) return;
    if (send(report)) sent.add(key);
  };
}

/** `prefix: detail`, or the prefix alone when the platform gave no detail. */
export function failureText(prefix: string, detail?: string | null): string {
  const trimmed = detail?.trim() ?? "";
  return trimmed === "" ? prefix : `${prefix}: ${trimmed}`;
}

/** Why a 3D model embedded as a markdown image shows no picture, naming the type the host serves. */
export function modelMarkdownError(mime: string): string {
  return `served ${mime}: 3D models only render in an openui Model block`;
}
