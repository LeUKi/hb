import { describe, expect, it } from "vitest";
import {
  TIP_CARD_HEIGHT,
  tipForumEmbed,
} from "../../apps/web/src/components/tips/embed";
import {
  FORUM_EMBED_BAR,
  FORUM_FRAME_MIN,
} from "../../packages/contracts/src/tips";

// 打赏卡 in a 社区 post (docs/tip-design.md §7): the iframe holds the 社区's
// bar, the card and the mini app's padding around it (8 above, 8 below),
// or the post shows a scrollbar (2026-11-05: every embed was 8 short) —
// and the 社区 never makes the frame under its bar less than 240.
describe("打赏卡's 社区 embed code", () => {
  it("is 309 for 简洁 and 标准, 387 with lists", () => {
    const heightOf = (card: number) =>
      /height="(\d+)"/.exec(tipForumEmbed("k7Q2mX", "lafish", card))?.[1];
    expect(heightOf(TIP_CARD_HEIGHT.simple)).toBe("309");
    expect(heightOf(TIP_CARD_HEIGHT.standard)).toBe("309");
    expect(heightOf(TIP_CARD_HEIGHT.list)).toBe("387");
  });
  it.each(Object.values(TIP_CARD_HEIGHT))(
    "leaves room for a card %ipx tall",
    (card) => {
      const height = Number(
        /height="(\d+)"/.exec(tipForumEmbed("k7Q2mX", "lafish", card))?.[1],
      );
      const frame = Math.max(FORUM_FRAME_MIN, card + 16);
      expect(height).toBeGreaterThanOrEqual(FORUM_EMBED_BAR + frame);
      expect(height).toBeLessThanOrEqual(
        FORUM_EMBED_BAR + Math.max(FORUM_FRAME_MIN, card + 24),
      );
    },
  );
});
