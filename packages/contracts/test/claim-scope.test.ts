import { describe, expect, it } from "vitest";
import {
  claimScopeSchema,
  levelsText,
  readClaimScope,
  scopeAllows,
  scopeSentence,
  scopeTag,
} from "../src/index";

// 领取范围 (docs/claim-scope-design.md).
const viewer = { linuxDoId: "100", username: "Alice", trustLevel: 1 };
const named = (username: string, linuxDoId: string | null = null) => ({
  username,
  linuxDoId,
});

describe("领取范围", () => {
  it("lets in either part: a level picked, or a name", () => {
    expect(scopeAllows(undefined, viewer)).toBe(true);
    expect(scopeAllows({ levels: [2, 3, 4] }, viewer)).toBe(false);
    expect(scopeAllows({ levels: [0, 1] }, viewer)).toBe(true);
    // Any levels, not only a range: Lv0 and Lv2 leave Lv1 out.
    expect(scopeAllows({ levels: [0, 2] }, viewer)).toBe(false);
    // Not known yet: no level takes them; a name still does.
    const unknown = { ...viewer, trustLevel: null };
    expect(scopeAllows({ levels: [0, 1, 2, 3] }, unknown)).toBe(false);
    const both = { levels: [2, 3, 4], users: [named("alice")] };
    expect(scopeAllows(both, unknown)).toBe(true);
    expect(scopeAllows(both, { ...viewer, username: "bob" })).toBe(false);
  });

  it("knows someone by LINUX DO ID once noted, renamed or not; by name otherwise", () => {
    const byId = { users: [named("old-name", "100")] };
    expect(scopeAllows(byId, viewer)).toBe(true);
    expect(
      scopeAllows(byId, { ...viewer, linuxDoId: "200", username: "old-name" }),
    ).toBe(false);
    expect(scopeAllows({ users: [named("ALICE")] }, viewer)).toBe(true);
  });

  it("asks for at least one part, not every level, and no repeated names", () => {
    expect(claimScopeSchema.safeParse({}).success).toBe(false);
    expect(claimScopeSchema.safeParse({ users: [] }).success).toBe(false);
    expect(claimScopeSchema.safeParse({ levels: [] }).success).toBe(false);
    expect(
      claimScopeSchema.safeParse({ levels: [4, 0, 2, 1, 3] }).success,
    ).toBe(false);
    expect(claimScopeSchema.safeParse({ levels: [5] }).success).toBe(false);
    // Low to high, each once.
    expect(claimScopeSchema.parse({ levels: [3, 1, 3] }).levels).toEqual([
      1, 3,
    ]);
    // The first version's range still reads, as its levels.
    expect(
      claimScopeSchema.parse({ levels: { min: 0, max: 2 } }).levels,
    ).toEqual([0, 1, 2]);
    expect(
      claimScopeSchema.safeParse({ levels: { min: 0, max: 4 } }).success,
    ).toBe(false);
    expect(
      claimScopeSchema.safeParse({ levels: { min: 3, max: 1 } }).success,
    ).toBe(false);
    expect(
      claimScopeSchema.safeParse({ users: [named("a"), named("A")] }).success,
    ).toBe(false);
    expect(
      claimScopeSchema.safeParse({ users: [named("@bob")] }).data?.users?.[0]
        ?.username,
    ).toBe("bob");
    expect(
      claimScopeSchema.safeParse({
        users: Array.from({ length: 101 }, (_, index) => named(`u${index}`)),
      }).success,
    ).toBe(false);
  });

  it("reads a 红包 saved with a range as its levels", () => {
    expect(readClaimScope({ levels: { min: 3, max: 3 } })).toEqual({
      levels: [3],
    });
    expect(
      readClaimScope({ levels: { min: 0, max: 2 }, users: [named("a")] }),
    ).toEqual({ levels: [0, 1, 2], users: [named("a")] });
    expect(readClaimScope({ levels: [2, 0] })).toEqual({ levels: [0, 2] });
    expect(readClaimScope({ users: [named("a")] })).toEqual({
      users: [named("a")],
    });
    expect(readClaimScope(undefined)).toBeUndefined();
  });

  it("says it the same way everywhere, its 或 plain", () => {
    expect(levelsText([2, 3, 4])).toBe("Lv2 及以上");
    expect(levelsText([0, 1, 2])).toBe("Lv0–2");
    expect(levelsText([1, 2, 3])).toBe("Lv1–3");
    expect(levelsText([3])).toBe("Lv3");
    expect(levelsText([4])).toBe("Lv4");
    expect(levelsText([3, 1])).toBe("Lv1、Lv3");
    expect(levelsText([0, 1, 3, 4])).toBe("Lv0–1、Lv3–4");
    expect(levelsText([0, 2, 3, 4])).toBe("Lv0、Lv2–4");
    const both = {
      levels: [2, 3, 4],
      users: [{ username: "a" }, { username: "b" }, { username: "c" }],
    };
    expect(scopeTag(both)).toBe("仅限 Lv2 及以上或指定的 3 人");
    expect(scopeTag({ ...both, levels: [1, 2, 3] })).toBe(
      "仅限 Lv1–3 或指定的 3 人",
    );
    expect(scopeTag({ ...both, levels: [1, 3] })).toBe(
      "仅限 Lv1、Lv3 或指定的 3 人",
    );
    expect(scopeTag({ levels: [1, 2, 3] })).toBe("仅限 Lv1–3");
    expect(scopeTag({ levels: [1, 3] })).toBe("仅限 Lv1、Lv3");
    expect(scopeTag({ users: [{ username: "a" }] })).toBe("仅限指定的 1 人");
    expect(scopeSentence(both, "领")).toBe(
      "Lv2 及以上的人，或指定的 3 位，都能领。",
    );
    expect(scopeSentence({ users: [{ username: "a" }] }, "报名")).toBe(
      "只有指定的 1 位能报名。",
    );
    expect(scopeSentence({ levels: [2] }, "领")).toBe("Lv2 的人能领。");
    expect(scopeSentence({ ...both, levels: [1, 3] }, "领")).toBe(
      "Lv1、Lv3 的人，或指定的 3 位，都能领。",
    );
  });
});
