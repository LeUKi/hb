/**
 * 打开附带网页？ (docs/attached-page-design.md §2.5): before a site's page
 * first loads in this browser, the viewer accepts what it is, in the
 * page's window. Accepted sites are kept here, by host; 收起 is not kept.
 */
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

export function acceptSite(site: string) {
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
