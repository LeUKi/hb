// SHA-256, SHA-1 and HMAC in plain JavaScript: the same file runs in the
// sandbox, in Node and in a browser, synchronously, with no node:crypto.

const encoder = new TextEncoder();

/** UTF-8 bytes of some text. */
export function utf8(text) {
  return encoder.encode(String(text));
}

/** Lower-case hex of some bytes. */
export function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Padded message blocks (FIPS 180-4 §5.1.1), shared by SHA-256 and SHA-1. */
function padded(data) {
  const length = data.length;
  const total = Math.ceil((length + 9) / 64) * 64;
  const buffer = new Uint8Array(total);
  buffer.set(data);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = length * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x100000000));
  view.setUint32(total - 4, bits >>> 0);
  return view;
}

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of some bytes. */
export function sha256(data) {
  const view = padded(data);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (k +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K256[i] +
          w[i]) |
        0;
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

/** SHA-1 of some bytes: only for TOTP, as authenticator apps expect. */
export function sha1(data) {
  const view = padded(data);
  const h = new Uint32Array([
    0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
  ]);
  const w = new Uint32Array(80);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++)
      w[i] = rotr(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 31);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotr(a, 27) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotr(b, 2);
      b = a;
      a = t;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

/** HMAC (RFC 2104) over a 64-byte-block hash. */
function hmac(hash, key, message) {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? hash(key) : key);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + (hash === sha1 ? 20 : 32));
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(hash(inner), 64);
  return hash(outer);
}

export const hmacSha256 = (key, message) => hmac(sha256, key, message);
export const hmacSha1 = (key, message) => hmac(sha1, key, message);

/** SHA-256 of some text (UTF-8), in lower-case hex. */
export function sha256Text(text) {
  return toHex(sha256(utf8(text)));
}
