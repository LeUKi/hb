import { describe, expect, it } from "vitest";
import { withPushed } from "../../apps/mini/src/live-merge";
import type {
  MiniLiveActivity,
  PublicActivity,
} from "../../packages/contracts/src/index";

// 社区小程序 (docs/mini-app-design.md §7): a pushed 红包 replaces the read
// but for what the push leaves out (sweep 2026-11-21, F4).

describe("a push over the mini app's read", () => {
  const read = {
    id: "activity",
    status: "active",
    title: "旧的标题",
    beforeInfo: "说明",
    author: { id: "author", displayName: "发红包的人", forumAvatar: 7 },
    scope: { trustLevels: [2] },
    rosterPreview: [{ id: "person" }],
    fundsPaused: { stopAt: "2026-11-24T00:00:00.000Z" },
  } as unknown as PublicActivity;

  it("drops a key the push no longer has, as a pause that ended", () => {
    const pushed = {
      id: "activity",
      status: "active",
      title: "新的标题",
    } as unknown as MiniLiveActivity;
    const merged = withPushed(read, pushed);
    expect(merged.fundsPaused).toBeUndefined();
    expect("fundsPaused" in merged).toBe(false);
    expect(merged.title).toBe("新的标题");
  });

  it("keeps what the push leaves out from the read", () => {
    const pushed = {
      id: "activity",
      status: "active",
      title: "新的标题",
    } as unknown as MiniLiveActivity;
    expect(withPushed(read, pushed)).toMatchObject({
      beforeInfo: "说明",
      author: read.author,
      scope: read.scope,
      rosterPreview: read.rosterPreview,
    });
    expect("judge" in withPushed(read, pushed)).toBe(false);
  });

  it("takes a pause the push brings", () => {
    const fundsPaused = { stopAt: "2026-11-25T00:00:00.000Z" };
    const pushed = {
      id: "activity",
      status: "active",
      title: "新的标题",
      fundsPaused,
    } as unknown as MiniLiveActivity;
    expect(withPushed(read, pushed).fundsPaused).toEqual(fundsPaused);
  });
});
