import { useSetAtom } from "jotai";
import { useIsPresent } from "motion/react";
import { useLayoutEffect } from "react";
import { pageTitleAtom } from "../../lib/store";

/**
 * Names the tab after what the page shows, when its route alone can't
 * (a 未找到 message, a list of results). Only the page on screen sets it;
 * a leaving page lets go at once, so the next page's own title wins.
 */
export function usePageTitle(title: string | null) {
  const setTitle = useSetAtom(pageTitleAtom);
  const present = useIsPresent();
  useLayoutEffect(() => {
    if (!present || !title) return;
    const mine = { title };
    setTitle(mine);
    return () => setTitle((current) => (current === mine ? null : current));
  }, [present, title, setTitle]);
}
