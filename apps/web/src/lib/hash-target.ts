import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * A link to a section of a page that reads its data first (/me#me-…,
 * /points/:id#my-key): the router scrolls before the section exists, so
 * this waits for it (a few seconds at most, watching the page, not polling)
 * and places it in view once per arrival. At once, not animated: the page
 * is still arriving, and a hidden tab draws no frames to animate with.
 */
export function useHashTarget() {
  const id = useLocation().hash.replace(/^#/, "");
  useEffect(() => {
    if (!id) return;
    const show = (element: HTMLElement) =>
      element.scrollIntoView({ block: "center" });
    const there = document.getElementById(id);
    if (there) {
      show(there);
      return;
    }
    const observer = new MutationObserver(() => {
      const element = document.getElementById(id);
      if (!element) return;
      observer.disconnect();
      show(element);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), 4000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [id]);
}
