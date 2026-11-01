/**
 * Where each entry of this tab's history went, by its index (TanStack's
 * __TSR_index): a page's 返回 (docs/judge-square-design.md §17.5) steps
 * back only when the entry before is the page it names; else it opens
 * that page.
 */
const paths = new Map<number, string>();

const plain = (path: string) => {
  try {
    return decodeURI(path).replace(/\/$/, "") || "/";
  } catch {
    return path;
  }
};

export function noteEntry(index: number | undefined, pathname: string) {
  if (index !== undefined) paths.set(index, plain(pathname));
}

/** Whether the entry before this one is the page at `path`. */
export function cameFrom(index: number | undefined, path: string) {
  return index !== undefined && paths.get(index - 1) === plain(path);
}
