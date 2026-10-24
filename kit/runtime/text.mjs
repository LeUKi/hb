// Text the way people mean it, for comparing answers loosely.

const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** NFKC (full-width to half-width and the like), no zero-width characters, single spaces, lower case. */
export function normalizeText(text) {
  return String(text)
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
