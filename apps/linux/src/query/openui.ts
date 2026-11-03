// Live OpenUI on the host: the board store's renderer (check the source, run its queries through
// the QueryService, evaluate it into the static spec older clients draw) and the one-line reason a
// source is refused, shared with the canvas DSL's `ui` nodes.

import { checkLiveOpenUI, renderLiveOpenUI, type OpenUIError, type WidgetSpec } from "@relay/protocol";
import type { QueryRelaying } from "./service";

/** The errors as one line: `items: unknown query tool "x"; root: ...`. */
export function liveErrors(errors: readonly OpenUIError[]): string {
  return errors.map((e) => (e.statementId === undefined ? e.message : `${e.statementId}: ${e.message}`)).join("; ");
}

/** Why `source` may not be written as a live widget, or null when it may. */
export function liveRefusal(source: string): string | null {
  const { errors } = checkLiveOpenUI(source);
  return errors.length === 0 ? null : liveErrors(errors);
}

/** A board store `LiveRender` over `query`: throws the refusal, else returns the rendered spec. */
export function liveRender(query: QueryRelaying): (source: string) => Promise<WidgetSpec> {
  return async (source) => {
    const render = await renderLiveOpenUI(source, async (tool, args) => {
      const answer = await query.run(tool, args, "boards");
      if (!answer.ok) throw new Error(answer.error);
      return answer.data;
    });
    if (render.node === null) throw new Error(liveErrors(render.errors));
    return render.node;
  };
}
