/**
 * What an interactive widget (a `reply` button, an input) can do where it's shown. The agent
 * screen provides a session to reply to; anywhere without one (boards, previews) those widgets
 * render disabled.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { sendCommand } from "@/connection";
import { warn } from "@/connection/log";

export interface WidgetActions {
  /** Sends `text` as the next user turn of the session whose transcript holds the widget. */
  reply: (text: string) => void;
}

const Context = createContext<WidgetActions | null>(null);

export function useWidgetActions(): WidgetActions | null {
  return useContext(Context);
}

/** Lets widgets below reply to `sessionId`; with no session, they stay disabled. */
export function SessionWidgetActions({
  sessionId,
  children,
}: {
  sessionId: string | undefined;
  children: ReactNode;
}) {
  const actions = useMemo<WidgetActions | null>(
    () =>
      sessionId === undefined
        ? null
        : {
            reply: (text) => {
              sendCommand({ kind: "agent.reply", sessionId, text, submit: true }).catch(
                (error: unknown) => {
                  warn("widget reply failed", error);
                },
              );
            },
          },
    [sessionId],
  );
  return <Context.Provider value={actions}>{children}</Context.Provider>;
}
