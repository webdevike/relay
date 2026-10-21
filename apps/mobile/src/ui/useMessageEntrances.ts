import { useEffect, useRef } from "react";

/** Capture before effects, since virtualized lists can mount cells after the parent commits. */
export function useMessageEntrances(messages: readonly { id: string }[] | undefined, ready: boolean) {
  const known = useRef(new Set(messages?.map((message) => message.id) ?? []));
  const loaded = useRef(ready);
  const entering = new Set(messages?.filter((message) => loaded.current && !known.current.has(message.id)).map((message) => message.id) ?? []);
  useEffect(() => {
    if (!ready) return;
    loaded.current = true;
    known.current = new Set(messages?.map((message) => message.id) ?? []);
  }, [messages, ready]);
  return entering;
}
