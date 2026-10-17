import { useCallback, useEffect, useRef, useState } from "react";

/** A message that clears itself `ms` after it is shown (toasts, brief hints). */
export function useTransientMessage(ms = 2200): { message: string | null; show: (message: string) => void } {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const show = useCallback(
    (next: string): void => {
      if (timer.current !== null) clearTimeout(timer.current);
      setMessage(next);
      timer.current = setTimeout(() => {
        setMessage(null);
        timer.current = null;
      }, ms);
    },
    [ms],
  );
  return { message, show };
}
