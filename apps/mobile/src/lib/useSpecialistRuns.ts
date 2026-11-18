import { useEffect, useMemo, useState } from "react";
import type { AgentRun, AssistantMessage } from "@relay/protocol";
import { shownSpecialists, specialistRuns } from "@/lib/specialistChips";
import { useDismissedCardsStore } from "@/state/dismissedCards";

/**
 * The specialist runs an assistant thread shows as chips and in the specialists sheet: `specialistRuns` of its rows,
 * read again each minute so a finished run leaves once its linger is over, minus the finished ones Isaac cleared
 * on the phone or on desktop (the host's dismissed-card set).
 */
export function useSpecialistRuns(messages: readonly AssistantMessage[]): AgentRun[] {
  const [minute, setMinute] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setMinute(Date.now());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const dismissed = useDismissedCardsStore((state) => state.ids);
  return useMemo(
    () => shownSpecialists(specialistRuns(messages, Math.max(minute, Date.now())), dismissed),
    [messages, minute, dismissed],
  );
}
