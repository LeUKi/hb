import { useEffect, useState } from "react";

const at = (count: number, period: number) =>
  Math.floor(Date.now() / period) % count;

/**
 * Which of `count` things to show now, by the clock: it moves on at every
 * whole `period`, so every window on every device whose clock is right
 * shows the same one at the same moment. 0 while not `running`. While the
 * page is in the back it keeps the one it shows and sets no timer; back in
 * front, it catches up with the clock at once.
 */
export function useClockCycle(count: number, period: number, running: boolean) {
  const [index, setIndex] = useState(() => at(count, period));
  useEffect(() => {
    if (!running) return;
    let timer: number | undefined;
    const tick = () => {
      window.clearTimeout(timer);
      setIndex(at(count, period));
      // A little past the boundary, so the next read is the next one.
      timer = window.setTimeout(tick, period - (Date.now() % period) + 5);
    };
    // Nobody sees a page in the back: no timer there, and it catches up on
    // return.
    const onVisibility = () => {
      if (document.hidden) window.clearTimeout(timer);
      else tick();
    };
    if (!document.hidden) tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [count, period, running]);
  return running ? index : 0;
}
