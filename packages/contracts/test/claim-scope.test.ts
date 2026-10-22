import { describe, expect, it } from "vitest";
import {
  claimScopeSchema,
  levelRangeText,
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
  it("lets in either part: a level in range, or a name", () => {
    expect(scopeAllows(undefined, viewer)).toBe(true);
    expect(scopeAllows({ levels: { min: 2, max: 4 } }, viewer)).toBe(false);
    expect(scopeAllows({ levels: { min: 0, max: 1 } }, viewer)).toBe(true);
    // Not known yet: no level range takes them; a name still does.
    const unknown = { ...viewer, trustLevel: null };
    expect(scopeAllows({ levels: { min: 0, max: 3 } }, unknown)).toBe(false);
    const both = { levels: { min: 2, max: 4 }, users: [named("alice")] };
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

  it("asks for at least one part, a real range and no repeated names", () => {
    expect(claimScopeSchema.safeParse({}).success).toBe(false);
    expect(claimScopeSchema.safeParse({ users: [] }).success).toBe(false);
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

  it("says it the same way everywhere, its 或 plain", () => {
    expect(levelRangeText({ min: 2, max: 4 })).toBe("Lv2 及以上");
    expect(levelRangeText({ min: 1, max: 3 })).toBe("Lv1–3");
    expect(levelRangeText({ min: 0, max: 0 })).toBe("Lv0");
    const both = {
      levels: { min: 2, max: 4 },
      users: [{ username: "a" }, { username: "b" }, { username: "c" }],
    };
    expect(scopeTag(both)).toBe("仅限 Lv2 及以上或指定的 3 人");
    expect(scopeTag({ ...both, levels: { min: 1, max: 3 } })).toBe(
      "仅限 Lv1–3 或指定的 3 人",
    );
    expect(scopeTag({ levels: { min: 1, max: 3 } })).toBe("仅限 Lv1–3");
    expect(scopeTag({ users: [{ username: "a" }] })).toBe("仅限指定的 1 人");
    expect(scopeSentence(both, "领")).toBe(
      "Lv2 及以上的人，或指定的 3 位，都能领。",
    );
    expect(scopeSentence({ users: [{ username: "a" }] }, "报名")).toBe(
      "只有指定的 1 位能报名。",
    );
    expect(scopeSentence({ levels: { min: 2, max: 2 } }, "领")).toBe(
      "Lv2 的人能领。",
    );
  });
});
