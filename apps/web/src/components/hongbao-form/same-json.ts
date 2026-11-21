// Whether JSON.stringify writes two values out alike, without writing either:
// 发红包's form is compared with what is saved on every render, and it can
// carry a 判定器's code (up to 256 KB) and texts of 10,000 characters
// (sweep 2026-11-21).

/** A value as JSON.stringify takes it under `key`; undefined: left out. */
function written(value: unknown, key: string): unknown {
  const json =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
      ? (value as { toJSON: (key: string) => unknown }).toJSON(key)
      : value;
  if (typeof json === "number") return Number.isFinite(json) ? json : null;
  return typeof json === "function" || typeof json === "symbol"
    ? undefined
    : json;
}

/** An object's members as written: keys in their order, none left out. */
function members(value: object) {
  const list: [string, unknown][] = [];
  for (const key of Object.keys(value)) {
    const json = written((value as Record<string, unknown>)[key], key);
    if (json !== undefined) list.push([key, json]);
  }
  return list;
}

function sameWritten(left: unknown, right: unknown): boolean {
  // The very same value: nothing under it is looked at.
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      const key = String(index);
      // An array writes what is left out as null.
      if (
        !sameWritten(
          written(left[index], key) ?? null,
          written(right[index], key) ?? null,
        )
      )
        return false;
    }
    return true;
  }
  const before = members(left);
  const after = members(right);
  return (
    before.length === after.length &&
    before.every(([key, value], index) => {
      const other = after[index];
      return other?.[0] === key && sameWritten(value, other[1]);
    })
  );
}

/**
 * `JSON.stringify(left) === JSON.stringify(right)` for plain data: keys in
 * their order, undefined and functions left out (null in an array), numbers
 * that are not finite as null, toJSON() as it answers. The very same value
 * is equal at once, so only what changed is looked into.
 */
export function sameJson(left: unknown, right: unknown) {
  return sameWritten(written(left, ""), written(right, ""));
}
