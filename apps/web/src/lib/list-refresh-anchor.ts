import { type RefObject, useLayoutEffect, useRef } from "react";

export type ListRefreshState = {
  fetching: boolean;
  updatedAt: number;
  error: boolean;
  scope: string;
};

/** Keep the visible record in place unless the user moves during the read. */
export function useListRefreshAnchor(
  ref: RefObject<HTMLElement | null>,
  { fetching, updatedAt, error, scope }: ListRefreshState,
) {
  const anchor = useRef<{
    id?: string;
    offset: number;
    top: number;
    updatedAt: number;
  } | null>(null);
  const previous = useRef({ scope, fetching: false });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const cancel = () => {
      anchor.current = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        [
          "PageDown",
          "PageUp",
          "Home",
          "End",
          "ArrowDown",
          "ArrowUp",
          " ",
        ].includes(event.key)
      )
        cancel();
    };
    node.addEventListener("scroll", cancel, { passive: true });
    node.addEventListener("wheel", cancel, { passive: true });
    node.addEventListener("touchstart", cancel, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    return () => {
      anchor.current = null;
      node.removeEventListener("scroll", cancel);
      node.removeEventListener("wheel", cancel);
      node.removeEventListener("touchstart", cancel);
      node.removeEventListener("keydown", onKeyDown);
    };
  }, [ref]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (previous.current.scope !== scope) {
      anchor.current = null;
      previous.current = { scope, fetching: false };
    }
    const rows = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          "[data-record-id], [data-activity-id]",
        ),
      );
    const recordId = (row: HTMLElement) =>
      row.dataset.recordId ?? row.dataset.activityId;
    if (fetching && !previous.current.fetching && updatedAt > 0) {
      const bounds = node.getBoundingClientRect();
      const row = rows().find(
        (item) => item.getBoundingClientRect().bottom > bounds.top,
      );
      anchor.current = {
        id: row && recordId(row),
        offset: row ? row.getBoundingClientRect().top - bounds.top : 0,
        top: node.scrollTop,
        updatedAt,
      };
    } else if (!fetching && anchor.current) {
      const saved = anchor.current;
      anchor.current = null;
      if (updatedAt !== saved.updatedAt && !error) {
        const row = rows().find((item) => recordId(item) === saved.id);
        node.scrollTop = row
          ? node.scrollTop +
            row.getBoundingClientRect().top -
            node.getBoundingClientRect().top -
            saved.offset
          : saved.top;
      }
    }
    previous.current = { scope, fetching };
  }, [ref, scope, fetching, updatedAt, error]);
}
