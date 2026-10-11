// SPDX-License-Identifier: Apache-2.0
// UUID-only adaptation of Keith Turner's Ecoji V2 encoding, pinned to v2.0.2.
// https://github.com/keith-turner/ecoji/blob/v2.0.2/v2/encode.go
// The upstream license and attribution are retained in ./ecoji-v2/.
import { z } from "zod";
import { ECOJI_V2_ALPHABET } from "./ecoji-v2/alphabet";

const UUID_SCHEMA = z.uuid();
const PADDING = "☕";
const VARIATION_SELECTOR = "\uFE0F";
const ORDINALS = new Map(
  ECOJI_V2_ALPHABET.map((symbol, ordinal) => [symbol, ordinal]),
);

/** Match the UUID forms accepted by the existing activity locator. */
export function normalizeActivityUuid(id: string): string | null {
  const parsed = UUID_SCHEMA.safeParse(id.toLowerCase());
  return parsed.success ? parsed.data : null;
}

/** Encode the UUID's 16 bytes as 13 data symbols and one Ecoji V2 padding symbol. */
export function encodeActivityEmoji(id: string): string {
  const uuid = normalizeActivityUuid(id);
  if (!uuid) throw new TypeError("Invalid activity UUID");

  // Two zero bits complete the final 10-bit symbol. ☕ marks the one-byte tail.
  const bits = BigInt(`0x${uuid.replaceAll("-", "")}`) << 2n;
  let code = "";
  for (let index = 12; index >= 0; index--) {
    const ordinal = Number((bits >> BigInt(index * 10)) & 1023n);
    const symbol = ECOJI_V2_ALPHABET[ordinal];
    if (symbol === undefined) throw new RangeError("Invalid Ecoji V2 ordinal");
    code += symbol;
  }
  return code + PADDING;
}

/** Decode Unicode only; percent decoding belongs to the URL boundary. */
export function decodeActivityEmoji(code: string): string | null {
  const symbols: string[] = [];
  let selectorAllowed = false;
  for (const symbol of code) {
    if (symbol === VARIATION_SELECTOR) {
      if (!selectorAllowed) return null;
      selectorAllowed = false;
      continue;
    }
    if (!ORDINALS.has(symbol) && symbol !== PADDING) return null;
    symbols.push(symbol);
    if (symbols.length > 14) return null;
    selectorAllowed = true;
  }
  if (symbols.length !== 14 || symbols[13] !== PADDING) return null;

  let bits = 0n;
  for (const symbol of symbols.slice(0, 13)) {
    const ordinal = ORDINALS.get(symbol);
    if (ordinal === undefined) return null;
    bits = (bits << 10n) | BigInt(ordinal);
  }
  const hex = (bits >> 2n).toString(16).padStart(32, "0");
  const uuid = normalizeActivityUuid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  // Upstream decoding ignores unused bits. Require our single canonical encoding.
  return uuid && encodeActivityEmoji(uuid) === symbols.join("") ? uuid : null;
}
