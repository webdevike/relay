/**
 * A ```html-widget fence: the agent's own HTML in an `HtmlFrame`, drawn once the fence closes.
 * `relay.reply(text)` in the page answers the session like a widget reply button.
 */
import { openExternal } from "@/lib/links";
import { HtmlFrame } from "@/ui/HtmlFrame";
import { useWidgetActions } from "./WidgetActions";

export function HtmlWidget({ html, partial, fontSize, lineHeight }: { html: string; partial: boolean; fontSize: number; lineHeight: number }) {
  const actions = useWidgetActions();
  return <HtmlFrame html={partial ? null : html} fontSize={fontSize} lineHeight={lineHeight} onReply={actions?.reply ?? null} onOpenLink={openExternal} />;
}
