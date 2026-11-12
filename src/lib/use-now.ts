import { useEffect, useState } from "react";

/** A wall clock for memoized recency math.  Counts like "attention runs in
 *  the past hour" derive from Date.now(), so memoizing them on the data array
 *  alone strands them: with no new run state nothing re-renders, and the
 *  windows freeze at the values they had when the array last changed.  A
 *  ticking state gives those memos an honest dependency.  The default minute
 *  tick is far finer than the hour/day windows it feeds, and one timer per
 *  mounted surface is cheap. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
