import { describe, expect, it } from "vitest";
import { sameJson } from "../../apps/web/src/components/hongbao-form/same-json";

// 发红包's dirty check (sweep 2026-11-21): it must say what comparing the two
// JSON.stringify texts said, so the unsaved-change guard moves exactly as it
// did.

const byText = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** A form shaped like 发红包's: a long code, a long 说明, nested parts. */
function formLike() {
  return {
    title: "",
    funding: "merchant",
    mode: "code",
    random: { total: "", count: "", algorithm: "double_mean" },
    judge: {
      total: "10",
      code: `export default function judge() {}\n${"// 判定\n".repeat(40_000)}`,
      tests: "[]",
      versions: { list: [{ n: 1, at: "2026-11-21T00:00:00.000Z" }] },
      judgeId: null as string | null,
      params: { rounds: "3" } as Record<string, unknown>,
      keys: {},
      borrowed: null,
    },
    passwords: [""],
    beforeInfo: "说明".repeat(5_000),
    scope: {
      limited: false,
      levels: [] as number[],
      users: [{ username: "alice" }] as {
        username: string;
        displayName?: string;
      }[],
    },
  };
}

describe("sameJson", () => {
  it("agrees with comparing JSON.stringify texts", () => {
    const form = formLike();
    const date = new Date(Date.UTC(2026, 10, 21));
    const keyed = { toJSON: (key: string) => `under ${key}` };
    const pairs: [unknown, unknown][] = [
      [form, form],
      [form, structuredClone(form)],
      [form, { ...form, beforeInfo: `${form.beforeInfo}。` }],
      [form, { ...form, judge: { ...form.judge, params: { rounds: 3 } } }],
      [
        form,
        {
          ...form,
          scope: {
            ...form.scope,
            users: [{ username: "alice", displayName: undefined }],
          },
        },
      ],
      // Keys in another order are written out differently.
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      // Integer keys come first either way.
      [
        { b: 1, 2: 1, 1: 1 },
        { 1: 1, 2: 1, b: 1 },
      ],
      [{ a: undefined }, {}],
      [{ a: () => 1 }, {}],
      [{ a: Symbol("a") }, {}],
      [{ a: null }, {}],
      [[undefined], [null]],
      [[() => 1], [null]],
      [[undefined], []],
      [{ a: Number.NaN }, { a: null }],
      [{ a: Number.POSITIVE_INFINITY }, { a: null }],
      [{ a: -0 }, { a: 0 }],
      [{ a: 1 }, { a: "1" }],
      [{ a: true }, { a: "true" }],
      [{ a: date }, { a: date.toISOString() }],
      [{ a: date }, { a: new Date(date.getTime() + 1) }],
      [{ x: keyed }, { x: "under x" }],
      [[keyed], ["under 0"]],
      [new Map([["a", 1]]), {}],
      [{ 0: "a" }, ["a"]],
      [{}, []],
      [
        [1, 2],
        [1, 2, 3],
      ],
      ["ab", "ac"],
      [undefined, undefined],
      [undefined, null],
      [null, {}],
    ];
    for (const [index, [left, right]] of pairs.entries())
      expect(sameJson(left, right), `pair ${index}`).toBe(byText(left, right));
  });

  it("does not look into what both sides share", () => {
    // Read, it throws: shared, it must not be read.
    const shared = {
      get code(): string {
        throw new Error("read a shared part");
      },
    };
    expect(
      sameJson({ judge: shared, title: "a" }, { judge: shared, title: "a" }),
    ).toBe(true);
    expect(
      sameJson({ judge: shared, title: "a" }, { judge: shared, title: "b" }),
    ).toBe(false);
  });

  it("tells an edit and its undoing apart as the texts would", () => {
    const saved = formLike();
    const typed = { ...saved, beforeInfo: `${saved.beforeInfo}!` };
    expect(sameJson(typed, saved)).toBe(false);
    // Typed back to what was saved: a new string, the same text.
    const undone = { ...typed, beforeInfo: typed.beforeInfo.slice(0, -1) };
    expect(sameJson(undone, saved)).toBe(true);
  });
});
