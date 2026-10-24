// 口令 the code can make or check: personal ones (HMAC → Crockford Base32),
// time-based ones (TOTP, RFC 6238, as authenticator apps make them) and
// time windows.
import { hmacSha1, hmacSha256, utf8 } from "./hash.mjs";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Crockford Base32 of some bytes: no I, L, O or U, easy to read out. */
export function crockford(bytes) {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

/** Read as Crockford reads it: any case, O as 0, I and L as 1, no spaces or dashes. */
export function normalizeCode(text) {
  return String(text)
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function sameCode(input, code) {
  return normalizeCode(input) === normalizeCode(code);
}

/** This person's 口令: HMAC-SHA256(key, parts joined by "\n"), first `length` characters. */
export function personalCode(key, parts, length = 10) {
  if (typeof key !== "string" || key === "")
    throw new TypeError("personal 的 key 要一个非空字符串");
  if (!Array.isArray(parts))
    throw new TypeError("personal 的 parts 要一个数组");
  if (!Number.isInteger(length) || length < 4 || length > 52)
    throw new RangeError("personal 的 length 要在 4 到 52 之间");
  const mac = hmacSha256(utf8(key), utf8(parts.map(String).join("\n")));
  return crockford(mac).slice(0, length);
}

/** RFC 4648 Base32, what authenticator apps use for their secrets. */
export function base32Decode(text) {
  const clean = String(text)
    .toUpperCase()
    .replace(/[\s=-]/g, "");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value === -1)
      throw new RangeError("totp 的密钥要是 Base32（A–Z 和 2–7）");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(out);
}

/** TOTP (RFC 6238, HMAC-SHA1) at `now`, `offset` steps away (-1 is the step before). */
export function totp(secret, { now, step = 30, digits = 6, offset = 0 }) {
  if (!Number.isInteger(step) || step < 1)
    throw new RangeError("totp 的 step 要是正整数（秒）");
  if (!Number.isInteger(digits) || digits < 6 || digits > 10)
    throw new RangeError("totp 的 digits 要在 6 到 10 之间");
  if (!Number.isInteger(offset))
    throw new RangeError("totp 的 offset 要是整数");
  const counter = Math.floor(now / 1000 / step) + offset;
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const mac = hmacSha1(base32Decode(secret), message);
  const start = mac[19] & 15;
  const binary =
    ((mac[start] & 0x7f) << 24) |
    (mac[start + 1] << 16) |
    (mac[start + 2] << 8) |
    mac[start + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Which `seconds`-long window `now` falls in, counted from 1970. */
export function timeWindow(now, seconds) {
  if (!(typeof seconds === "number" && seconds > 0))
    throw new RangeError("window 的秒数要大于 0");
  return Math.floor(now / 1000 / seconds);
}
