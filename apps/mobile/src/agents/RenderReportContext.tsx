/**
 * The React side of render reports (`renderReport.ts`). An assistant's chat row provides its bubble
 * (`RenderMessage`: reaction thread + reaction key, the same on every device); fenced blocks say how
 * the agent embedded the media (`RenderFormContext`: markdown unless an ```openui or legacy ```ui
 * block says otherwise). Every media element calls `useRenderFailure()` when it fails to show. Outside
 * an assistant bubble (dashboards, Reviews, Catch Up, Isaac's own turns) it does nothing: no agent
 * owns that media.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { RenderForm, RenderKind } from "@relay/protocol";
import { reportRenderFailure } from "@/connection";
import { createRenderReporter } from "./renderReport";

interface RenderMessageValue {
  thread: string;
  message: string;
}

const RenderMessageContext = createContext<RenderMessageValue | null>(null);

/** How the media on this level was embedded; the transcript's default is a markdown image. */
export const RenderFormContext = createContext<RenderForm>("markdown");

/** Module-wide, so a bubble that scrolls away and back (or remounts on a new snapshot) reports once per run. */
const report = createRenderReporter(reportRenderFailure);

export interface RenderMessageProps {
  /** The bubble's reaction thread (`assistantReactionThread` / `sessionReactionThread`); null while there is none. */
  thread: string | null;
  /** The bubble's reaction key (`bubbleReactionKey`); null for a pending echo, which no agent owns yet. */
  message: string | null;
  children: ReactNode;
}

/** Wraps a whole assistant row (tiles above the bubble included) so its media can report failures. */
export function RenderMessage({ thread, message, children }: RenderMessageProps) {
  const value = useMemo(() => (thread === null || message === null ? null : { thread, message }), [thread, message]);
  return <RenderMessageContext.Provider value={value}>{children}</RenderMessageContext.Provider>;
}

/**
 * `(kind, src, error)` for a media element that failed to show. `src` is the src as the agent wrote
 * it (a `/drops/...` path or https URL), never the resolved host URL; `error` a short reason.
 */
export function useRenderFailure(): (kind: RenderKind, src: string, error: string) => void {
  const bubble = useContext(RenderMessageContext);
  const form = useContext(RenderFormContext);
  return useCallback(
    (kind: RenderKind, src: string, error: string) => {
      if (bubble === null || src === "") return;
      report({ ...bubble, kind, form, src, error });
    },
    [bubble, form],
  );
}
