// The author's files: judge.js, tests.json, simulate.json and a downloaded
// records file, read with plain words when one is missing.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Text } from "../../runtime/index.mjs";

/** A problem to say and stop on: printed as it is, exit code 1. */
export class KitError extends Error {}

/**
 * A file's text as the site gets it pasted: its editor and textareas give
 * LF line ends and no BOM, so the fingerprint, the sizes and what runs are
 * the same here for a file saved with CRLF (Windows) or a BOM.
 */
export async function readText(path, label = path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new KitError(`找不到 ${label}`);
    throw error;
  }
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** A file of the kit's own directory, by name. */
export const readProjectFile = (dir, name) => readText(join(dir, name), name);

/** judge.js's fingerprint: SHA-256 of its text, as the site shows it. */
export const fingerprintOf = (code) => sha256Text(code);

export const bytesOf = (text) => new TextEncoder().encode(text).length;

export function sizeText(bytes) {
  return bytes < 1024 ? `${bytes} 字节` : `${(bytes / 1024).toFixed(1)} KB`;
}
