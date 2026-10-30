import { atom, type useStore } from "jotai";

/**
 * 打开附带网页？ (docs/attached-page-design.md §2.5): before a site's page
 * first loads in this browser, the viewer accepts what it is. Accepted
 * sites are kept here, by host; 取消 is not kept.
 */
export type PageRiskRequest = {
  /** The page's host name. */
  site: string;
  /** Whose 红包 carries it (LINUX DO username), when known. */
  author: string | null;
  resolve: (open: boolean) => void;
};

export const pageRiskAtom = atom<PageRiskRequest | null>(null);

type Store = ReturnType<typeof useStore>;

const ACCEPTED = "hb.page-sites";
const ACCEPTED_MAX = 200;
/** Where storage is not kept (a private window): this load's. */
const acceptedNow = new Set<string>();

function acceptedList(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ACCEPTED) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((site): site is string => typeof site === "string")
      : [];
  } catch {
    return [];
  }
}

export function siteAccepted(site: string) {
  return acceptedNow.has(site) || acceptedList().includes(site);
}

function accept(site: string) {
  acceptedNow.add(site);
  try {
    localStorage.setItem(
      ACCEPTED,
      JSON.stringify(
        [...acceptedList().filter((saved) => saved !== site), site].slice(
          -ACCEPTED_MAX,
        ),
      ),
    );
  } catch {
    // Kept for this load only.
  }
}

/** True once the site is accepted (now or before), false on 取消. */
export async function askPageRisk(
  store: Store,
  { site, author }: { site: string; author: string | null },
) {
  if (siteAccepted(site)) return true;
  // One ask at a time: a second waits on the same answer.
  const asking = store.get(pageRiskAtom);
  if (asking?.site === site)
    return new Promise<boolean>((resolve) => {
      const previous = asking.resolve;
      asking.resolve = (open) => {
        previous(open);
        resolve(open);
      };
    });
  asking?.resolve(false);
  const open = await new Promise<boolean>((resolve) => {
    let settled = false;
    store.set(pageRiskAtom, {
      site,
      author,
      resolve: (answer) => {
        if (settled) return;
        settled = true;
        store.set(pageRiskAtom, null);
        resolve(answer);
      },
    });
  });
  if (open) accept(site);
  return open;
}
