/**
 * The pure half of a live ```openui fence (OpenUIBlock renders it): one `OpenUIRuntime` per fence
 * holds the widget's `$variable` state, is fed every streamed version of the fence, and runs
 * button actions locally. No React Native, so vitest covers it.
 */
import {
  createOpenUIRuntime,
  type OpenUIDispatch,
  type OpenUIQueryClient,
  type OpenUIRuntime,
  type ParseOpenUIResult,
} from "@relay/protocol";
import type { ButtonSpec, WidgetSpec } from "./widget";

/** What a fence shows: its live widget, or its source as code (flagged invalid once it's closed). */
export type OpenUIView = { kind: "widget"; spec: WidgetSpec } | { kind: "code"; invalid: boolean };

/** Creates the fence's runtime on first sight (its Query statements fetching through `query`, or
 * showing their defaults without one), then feeds it each new version of the text, so state the
 * user changed survives streaming. */
export function syncOpenUIRuntime(
  runtime: OpenUIRuntime | null,
  code: string,
  partial: boolean,
  query: OpenUIQueryClient | null = null,
): OpenUIRuntime {
  if (runtime === null) return createOpenUIRuntime(code, { partial, query });
  runtime.update(code, { partial });
  return runtime;
}

export function openUIView(snapshot: ParseOpenUIResult, partial: boolean): OpenUIView {
  // A still-streaming fence is just unfinished, not invalid.
  return snapshot.node
    ? { kind: "widget", spec: snapshot.node }
    : { kind: "code", invalid: !partial };
}

/** What a button tap asks the host to do. An `action` button first runs its local steps on the
 * fence's runtime (no network, so the widget updates at once), then hands back any reply (with the
 * assistant it goes to) or url those steps produced; a plain button carries its own. */
export function pressButton(spec: ButtonSpec, runtime: OpenUIRuntime | null): OpenUIDispatch {
  if (spec.action !== undefined) return runtime?.dispatch(spec.action) ?? {};
  return {
    ...(spec.reply === undefined ? {} : { reply: spec.reply }),
    ...(spec.agent === undefined ? {} : { agent: spec.agent }),
    ...(spec.url === undefined ? {} : { url: spec.url }),
  };
}

/** Whether a tap can do anything where the button is drawn: an `action` needs its fence's runtime; a
 * `url` or a reply to an assistant (`agent`) works anywhere; a plain reply needs a session to answer
 * (`canReply`), so on a board it is disabled. */
export function buttonEnabled(
  spec: ButtonSpec,
  runtime: OpenUIRuntime | null,
  canReply: boolean,
): boolean {
  if (spec.action !== undefined) return runtime !== null;
  return spec.url !== undefined || spec.agent !== undefined || canReply;
}
