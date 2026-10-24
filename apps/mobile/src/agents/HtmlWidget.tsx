/**
 * A ```html-widget or ```mantine-widget fence: the agent's own HTML, or its JSX on the bundled Mantine
 * runtime, in an `HtmlFrame`, drawn once the fence closes. `relay.reply(text)` in the page answers
 * the session like a widget reply button.
 */
import { openExternal } from "@/lib/links";
import { HtmlFrame } from "@/ui/HtmlFrame";
import { useWidgetActions } from "./WidgetActions";

export interface HtmlWidgetProps {
  code: string;
  runtime: "html" | "mantine";
  partial: boolean;
  fontSize: number;
  lineHeight: number;
}

export function HtmlWidget({ code, runtime, partial, fontSize, lineHeight }: HtmlWidgetProps) {
  const actions = useWidgetActions();
  return (
    <HtmlFrame
      code={partial ? null : code}
      runtime={runtime}
      fontSize={fontSize}
      lineHeight={lineHeight}
      onReply={actions?.reply ?? null}
      onOpenLink={openExternal}
    />
  );
}
