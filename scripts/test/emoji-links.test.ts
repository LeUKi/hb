import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityShareUrl,
  decodeActivityEmoji,
  encodeActivityEmoji,
  parseActivityLink,
  resolveEmojiPath,
} from "../../apps/web/src/lib/emoji-links";
import { ECOJI_V2_ALPHABET } from "../../packages/contracts/src/ecoji-v2/alphabet";

const ID = "cecef876-ddbb-4ed5-93ce-9b311e3df3ea";
const CODE = "🚷🎼📯😨😸🎺🐵🦄🪁🚍🤽📄🥘☕";
const ORIGIN = "https://redeem.example";
const ENCODED = encodeURIComponent(CODE);
const WITH_SELECTORS = `${Array.from(CODE).join("\uFE0F")}\uFE0F`;

// Calculated independently from the pinned upstream five-byte Go algorithm.
const upstreamVectors = [
  { id: ID, code: CODE },
  {
    id: "00000000-0000-0000-0000-000000000000",
    code: "🀄🀄🀄🀄🀄🀄🀄🀄🀄🀄🀄🀄🀄☕",
  },
  {
    id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    code: "🧕🧕🧕🧕🧕🧕🧕🧕🧕🧕🧕🧕🧒☕",
  },
  {
    id: "12345678-1234-4234-8234-123456789abc",
    code: "🌎🛁👯⚓🧆⭐🏮🔇🌎🛁👯🍢😻☕",
  },
];

afterEach(() => vi.unstubAllEnvs());

describe("pinned Ecoji V2 UUID codec", () => {
  it("freezes all 1024 upstream ordinals without changing their order", () => {
    expect(Object.isFrozen(ECOJI_V2_ALPHABET)).toBe(true);
    expect(ECOJI_V2_ALPHABET).toHaveLength(1024);
    expect(new Set(ECOJI_V2_ALPHABET).size).toBe(1024);
    expect(
      createHash("sha256").update(ECOJI_V2_ALPHABET.join("")).digest("hex"),
    ).toBe("b9b2258f7be17cd87708a4af197d42d9653ce5b92d0621262bb252c67f7fec88");
  });

  it.each(upstreamVectors)(
    "matches upstream 16-byte vector $id",
    ({ id, code }) => {
      expect(encodeActivityEmoji(id)).toBe(code);
      expect(encodeActivityEmoji(id.toUpperCase())).toBe(code);
      expect(decodeActivityEmoji(code)).toBe(id);
      expect(Array.from(code)).toHaveLength(14);
    },
  );

  it.each([1, 2, 3, 5, 6, 7, 8])(
    "accepts the existing UUID v%s contract",
    (version) => {
      const id = `12345678-1234-${version}234-8234-123456789abc`;
      expect(decodeActivityEmoji(encodeActivityEmoji(id))).toBe(id);
    },
  );

  it("round-trips random UUIDs and generates distinct codes", () => {
    const ids = Array.from({ length: 128 }, () => randomUUID());
    const codes = ids.map(encodeActivityEmoji);
    expect(new Set(codes).size).toBe(ids.length);
    expect(codes.map(decodeActivityEmoji)).toEqual(ids);
  });

  it.each([
    "",
    "activity",
    ID.replaceAll("-", ""),
    `${ID}x`,
    ` ${ID}`,
    "12345678-1234-0234-8234-123456789abc",
    "12345678-1234-4234-7234-123456789abc",
  ])("throws for invalid UUID input %s", (id) => {
    expect(() => encodeActivityEmoji(id)).toThrow("Invalid activity UUID");
  });

  it("accepts one optional emoji variation selector after a legitimate glyph", () => {
    expect(decodeActivityEmoji(WITH_SELECTORS)).toBe(ID);
    expect(decodeActivityEmoji(CODE.replace("🚷", "🚷\uFE0F"))).toBe(ID);
    expect(decodeActivityEmoji(`${CODE}\uFE0F`)).toBe(ID);
  });

  it.each([
    "",
    CODE.slice(0, -1),
    `${CODE}☕`,
    `${CODE}☕☕`,
    CODE.replace("☕", "🀄"),
    CODE.replace("🚷", "☕"),
    CODE.replace("🚷", "🟠"),
    CODE.replace("🚷", "🚷 "),
    CODE.replace("🚷", "🚷\uFE0F\uFE0F"),
    CODE.replace("🚷", "🚷\uFE0E"),
    `\uFE0F${CODE}`,
    `${CODE}\u200D`,
    ENCODED,
    "🚷🎼📯😨😸🎺🐵🦄🕊🚍🤽📄🥘☕☕☕",
    "🌎🛁👯⚓🧅⭐🏮🔇🌎🛁👯🍢😻☕",
  ])("rejects malformed, V1, or non-UUID code %s", (code) => {
    expect(decodeActivityEmoji(code)).toBeNull();
  });

  it.each(["🥙", "🥚", "🥛"])(
    "rejects unused-bit alias ending %s☕",
    (alias) => {
      expect(decodeActivityEmoji(CODE.replace("🥘", alias))).toBeNull();
    },
  );
});

describe("activity link boundaries", () => {
  it.each([
    `/e/${CODE}`,
    `/e/${ENCODED}`,
    `/e/${ENCODED.toLowerCase()}/`,
    `/e/${encodeURIComponent(WITH_SELECTORS)}`,
    `/e/${encodeURIComponent("🚷")}${CODE.slice("🚷".length)}`,
  ])("resolves one encoded pathname %s", (pathname) => {
    expect(resolveEmojiPath(pathname)).toBe(ID);
  });

  it.each([
    "/e/",
    "/e",
    `/e/${encodeURIComponent(ENCODED)}`,
    `/e/${ENCODED}%`,
    `/e/${ENCODED}%FF`,
    `/e/${ENCODED}%2F`,
    `/e/${CODE}/extra`,
    `/e/${CODE}//`,
    `/e/${CODE}?next=1`,
    `/e/${CODE}#fragment`,
    `/e/${ID}`,
    `/other/e/${CODE}`,
    `/e/%EF%B8%8F${ENCODED}`,
  ])("rejects malformed or double-encoded pathname %s", (pathname) => {
    expect(resolveEmojiPath(pathname)).toBeNull();
  });

  it.each([
    ID,
    `  ${ID.toUpperCase()}  `,
    CODE,
    `  ${WITH_SELECTORS}  `,
    `${ORIGIN}/e/${CODE}`,
    `${ORIGIN}/e/${ENCODED}`,
    `${ORIGIN}/e/${ENCODED}/?source=forum#copied`,
    `${ORIGIN}/e/${encodeURIComponent(WITH_SELECTORS)}?next=/ignored#ignored`,
    `${ORIGIN}/activities/${ID}`,
    `${ORIGIN}/activities/${ID.toUpperCase()}/?source=forum#copied`,
    `https://redeem.example:443/e/${CODE}`,
  ])("locates an ID from accepted input %s", (input) => {
    expect(parseActivityLink(input, ORIGIN)).toBe(ID);
  });

  it.each([
    "",
    ENCODED,
    `/e/${CODE}`,
    `//redeem.example/e/${CODE}`,
    `https://another.example/e/${CODE}`,
    `http://redeem.example/e/${CODE}`,
    `https://redeem.example:8443/e/${CODE}`,
    `https://user:password@redeem.example/e/${CODE}`,
    `https://@redeem.example/e/${CODE}`,
    `javascript:${ORIGIN}/e/${CODE}`,
    `file:///e/${CODE}`,
    `https:///redeem.example/e/${CODE}`,
    `${ORIGIN}/other/../e/${CODE}`,
    `${ORIGIN}/e/${CODE}/extra`,
    `${ORIGIN}/e/${encodeURIComponent(ENCODED)}`,
    `${ORIGIN}/e/${ENCODED}%`,
    `${ORIGIN}/activities/${ID}%2F`,
    `${ORIGIN}/activities/${ID}/claim`,
    `${ORIGIN}/#/e/${CODE}`,
    `${ORIGIN}/e/\n${CODE}`,
    `https://redeem.example\\e\\${CODE}`,
  ])("rejects unsafe or unrecognized activity input %s", (input) => {
    expect(parseActivityLink(input, ORIGIN)).toBeNull();
  });

  it("supports the local development origin while keeping origins separate", () => {
    expect(
      parseActivityLink(
        `http://127.0.0.1:5173/e/${CODE}`,
        "http://127.0.0.1:5173",
      ),
    ).toBe(ID);
    expect(
      parseActivityLink(`${ORIGIN}/e/${CODE}`, "not an origin"),
    ).toBeNull();
  });
});

describe("activity share URL generation", () => {
  it("copies visible canonical emoji without any query or fragment", () => {
    vi.stubEnv("VITE_EMOJI_LINKS_RECOVERY", "0");
    const link = activityShareUrl(
      ID.toUpperCase(),
      `${ORIGIN}/?previous=1#old`,
    );
    expect(link).toBe(`${ORIGIN}/e/${CODE}`);
    expect(link).not.toContain("%");
    expect(parseActivityLink(new URL(link).href, ORIGIN)).toBe(ID);
    expect(resolveEmojiPath(new URL(link).pathname)).toBe(ID);
  });

  it.each(["", "0", "true"])(
    "keeps emoji enabled for recovery value %s",
    (value) => {
      vi.stubEnv("VITE_EMOJI_LINKS_RECOVERY", value);
      expect(activityShareUrl(ID, ORIGIN)).toBe(`${ORIGIN}/e/${CODE}`);
    },
  );

  it("generates legacy links only for the explicit recovery build", () => {
    vi.stubEnv("VITE_EMOJI_LINKS_RECOVERY", "1");
    expect(activityShareUrl(ID.toUpperCase(), ORIGIN)).toBe(
      `${ORIGIN}/activities/${ID}`,
    );
    expect(parseActivityLink(`${ORIGIN}/e/${CODE}`, ORIGIN)).toBe(ID);
    expect(resolveEmojiPath(`/e/${ENCODED}`)).toBe(ID);
  });

  it("refuses invalid IDs and site origins", () => {
    expect(() => activityShareUrl("bad-id", ORIGIN)).toThrow(
      "Invalid activity UUID",
    );
    expect(() => activityShareUrl(ID, "not an origin")).toThrow();
    expect(() =>
      activityShareUrl(ID, "https://user:secret@redeem.example"),
    ).toThrow("Invalid site origin");
    expect(() => activityShareUrl(ID, "ftp://redeem.example")).toThrow(
      "Invalid site origin",
    );
  });
});
