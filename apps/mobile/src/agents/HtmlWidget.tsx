/**
 * A ```html-widget or ```mantine-widget fence: the agent's own HTML, or its JSX on the bundled Mantine
 * runtime, in an `HtmlFrame`, drawn once the fence closes. `relay.reply(text)` in the page answers
 * the session like a widget reply button; `relay.reply(text, {agent})` sends to that assistant's
 * thread instead. A link the page opens without a tap never sends (`openChatLink` `gesture`).
 */
import { routeReply } from "@/boards/assistantSend";
import { useSendToAssistant } from "@/boards/TileSend";
import { openChatLink } from "@/lib/links";
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
  const sendToAssistant = useSendToAssistant();
  return (
    <HtmlFrame
      code={partial ? null : code}
      runtime={runtime}
      fontSize={fontSize}
      lineHeight={lineHeight}
      onReply={(text, agent) => {
        routeReply(text, agent, { session: actions?.reply ?? null, assistant: sendToAssistant });
      }}
      onOpenLink={openChatLink}
    />
  );
}
