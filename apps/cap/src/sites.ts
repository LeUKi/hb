// The sites this Cap serves (docs/cap-design.md §2). For now they are
// written in the configuration (CAP_SITES); a site's secret itself stays with
// the site, and only its SHA-256 is here.

export type Site = {
  /** Public, in every request's path. */
  key: string;
  name: string;
  /** SHA-256 (hex) of the secret the site's backend sends to siteverify. */
  secretHash: string;
  /** Origins whose pages may ask for challenges directly ("*" for any). */
  origins: string[];
  /** Puzzles a challenge holds (Cap's default 50). */
  challengeCount: number;
  /** Leading hex zeros each puzzle needs (Cap's default 4). */
  difficulty: number;
  /** Cap's browser checks (headless browsers and the like). */
  instrumentation: boolean;
};

const SITE_KEY = /^[a-z0-9-]{2,64}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function invalid(reason: string): never {
  throw new Error(`CAP_SITES_INVALID: ${reason}`);
}

/** CAP_SITES, checked: a deploy with a broken list fails on every request. */
export function parseSites(raw: string | undefined): Map<string, Site> {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? "[]");
  } catch {
    invalid("not JSON");
  }
  if (!Array.isArray(list)) invalid("not a list");
  const sites = new Map<string, Site>();
  for (const entry of list as Record<string, unknown>[]) {
    const key = entry?.key;
    if (typeof key !== "string" || !SITE_KEY.test(key)) invalid("key");
    if (sites.has(key)) invalid(`duplicate ${key}`);
    const secretHash = entry.secretHash;
    if (typeof secretHash !== "string" || !HEX_SHA256.test(secretHash))
      invalid(`${key} secretHash`);
    const origins = entry.origins ?? [];
    if (
      !Array.isArray(origins) ||
      origins.some(
        (origin) =>
          typeof origin !== "string" ||
          (origin !== "*" && new URL(origin).origin !== origin),
      )
    )
      invalid(`${key} origins`);
    const challengeCount = entry.challengeCount ?? 50;
    const difficulty = entry.difficulty ?? 4;
    if (
      !Number.isInteger(challengeCount) ||
      (challengeCount as number) < 1 ||
      (challengeCount as number) > 500 ||
      !Number.isInteger(difficulty) ||
      (difficulty as number) < 1 ||
      (difficulty as number) > 8
    )
      invalid(`${key} challenge`);
    sites.set(key, {
      key,
      name: typeof entry.name === "string" ? entry.name : key,
      secretHash,
      origins: origins as string[],
      challengeCount: challengeCount as number,
      difficulty: difficulty as number,
      instrumentation: entry.instrumentation !== false,
    });
  }
  return sites;
}

let parsed: { raw: string | undefined; sites: Map<string, Site> } | null = null;

/** The configured sites, parsed once per isolate. */
export function sitesOf(raw: string | undefined) {
  const sites = parsed && parsed.raw === raw ? parsed.sites : parseSites(raw);
  parsed = { raw, sites };
  return sites;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/**
 * The key a site's challenges are signed with, derived from the master
 * secret: a challenge one site gave out cannot be redeemed at another.
 */
export async function siteSecret(master: string, siteKey: string) {
  if (master.length < 16) throw new Error("CAP_MASTER_SECRET_TOO_SHORT");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(master),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`cap-site:${siteKey}`),
    ),
  );
}

/** Whether a secret sent to siteverify is this site's, in constant time. */
export async function secretMatches(site: Site, secret: string) {
  const sent = await sha256Hex(secret);
  let difference = sent.length ^ site.secretHash.length;
  for (let i = 0; i < sent.length; i++)
    difference |= sent.charCodeAt(i) ^ site.secretHash.charCodeAt(i);
  return difference === 0;
}
