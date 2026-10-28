import { useEffect, useState } from "react";

/** `Date.now()`, refreshed every second while `running` (call timers). */
export function useSecondClock(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  return now;
}
