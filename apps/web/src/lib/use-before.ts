import { useEffect, useState } from "react";

/** True until a moment passes, with one re-render then (no ticking). */
export function useBefore(moment: number) {
  const [, passed] = useState(0);
  useEffect(() => {
    const left = moment - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => passed((count) => count + 1), left + 20);
    return () => clearTimeout(timer);
  }, [moment]);
  return moment > Date.now();
}
