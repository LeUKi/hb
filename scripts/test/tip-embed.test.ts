import { describe, expect, it } from "vitest";
import {
  TIP_CARD_HEIGHT,
  tipForumEmbed,
} from "../../apps/web/src/components/tips/embed";
import { FORUM_EMBED_BAR } from "../../packages/contracts/src/tips";

// 打赏卡 in a 社区 post (docs/tip-design.md §7): the iframe holds the 社区's
// bar, the card and the mini app's padding around it (8 above, 8 below),
// or the post shows a scrollbar (2026-11-05: every embed was 8 short).
describe("打赏卡's 社区 embed code", () => {
  it.each(Object.values(TIP_CARD_HEIGHT))(
    "leaves room for a card %ipx tall",
    (card) => {
      const height = Number(
        /height="(\d+)"/.exec(tipForumEmbed("k7Q2mX", "lafish", card))?.[1],
      );
      expect(height).toBeGreaterThanOrEqual(FORUM_EMBED_BAR + card + 16);
      expect(height).toBeLessThanOrEqual(FORUM_EMBED_BAR + card + 24);
    },
  );
});
