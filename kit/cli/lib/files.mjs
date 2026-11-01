// The author's files: judge.js, tests.json, simulate.json and a downloaded
// records file, read with plain words when one is missing.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { keyTarget, sha256Text } from "../../runtime/index.mjs";

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

/**
 * 密钥 for going out with --live (docs/judge-key-design.md §5):
 * keys.local.json beside judge.js, `{ "ai": "sk-…" }`, kept out of git;
 * none without it.
 */
export async function readLocalKeys(dir) {
  let text;
  try {
    text = await readText(join(dir, "keys.local.json"), "keys.local.json");
  } catch (error) {
    if (error instanceof KitError) return {};
    throw error;
  }
  const shape = 'keys.local.json 要写成 { "ai": "sk-…" }，每个值是一行文字';
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KitError(shape);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((key) => typeof key !== "string")
  )
    throw new KitError(shape);
  return value;
}

/**
 * What --live goes out with: each 密钥 read, or that it goes without; a
 * `to` that is an 地址参数 as `values` (simulate.json's) fill it.
 */
export function keyLines(params, keys, values = {}) {
  return params
    .filter((item) => item.type === "key")
    .map((item) => {
      const to = keyTarget(item, values) ?? `${item.to.param} 填的地址`;
      return typeof keys[item.key] === "string"
        ? `密钥 ${item.key}：从 keys.local.json 读，只发给 ${to}`
        : `提醒：keys.local.json 里没有密钥 ${item.key}，请求 ${to} 时不带它`;
    });
}

/**
 * 地址参数 simulate.json fills with the kit's own http://localhost
 * (docs/judge-address-design.md §8): a reminder each.
 */
export function localAddressLines(params, values) {
  return params
    .filter(
      (item) =>
        item.type === "url" &&
        typeof values[item.key] === "string" &&
        values[item.key].startsWith("http://"),
    )
    .map(
      (item) =>
        `提醒：地址参数 ${item.key} 用的是本地地址 ${values[item.key]}，网站上要填 https 地址`,
    );
}

/** judge.js's fingerprint: SHA-256 of its text, as the site shows it. */
export const fingerprintOf = (code) => sha256Text(code);

export const bytesOf = (text) => new TextEncoder().encode(text).length;

export function sizeText(bytes) {
  return bytes < 1024 ? `${bytes} 字节` : `${(bytes / 1024).toFixed(1)} KB`;
}
