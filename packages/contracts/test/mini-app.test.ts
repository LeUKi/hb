import { describe, expect, it } from "vitest";
import {
  forumMiniAppEmbed,
  type MiniEmbedShape,
  miniAppEmbedHeight,
} from "../src/mini-app";

const shape = (extra: Partial<MiniEmbedShape> = {}): MiniEmbedShape => ({
  participation: "password",
  humanCheck: false,
  scoped: false,
  title: "周末红包",
  beforeInfo: "社区里也能领了。",
  tags: ["口令红包", "拼手气 · 微信同款"],
  ...extra,
});

describe("社区小程序's embed height", () => {
  // Pages as measured at a desktop post's width (docs §4), each with the
  // 社区's 68px bar and 12px of room, up to the next ten.
  it("fits each 红包's tallest page, as measured", () => {
    expect(miniAppEmbedHeight(shape())).toBe(710); // 624, a wrong 口令
    expect(miniAppEmbedHeight(shape({ participation: "code" }))).toBe(730); // 644
    expect(
      miniAppEmbedHeight(shape({ participation: "direct", humanCheck: true })),
    ).toBe(730);
    expect(
      miniAppEmbedHeight(
        shape({
          title: "周末红包：解开三道谜题的人都有份，第四道谜题的口令在说明最后",
          beforeInfo: "第一道。\n第二道。\n第三道。",
        }),
      ),
    ).toBe(790); // 710
    // A 口令 field and the card asking a first-timer to sign in first.
    expect(miniAppEmbedHeight(shape({ scoped: true }))).toBe(740);
  });

  it("is never lower than a claimed page, a 附言 at three lines", () => {
    expect(miniAppEmbedHeight(shape({ participation: "direct" }))).toBe(700); // 538 → 620
    expect(miniAppEmbedHeight(shape({ beforeInfo: "" }))).toBe(700); // 576 → 620
  });

  it("counts the 说明's lines at 29 wide characters, narrow ones as half", () => {
    const zh = (n: number) => "红".repeat(n);
    expect(miniAppEmbedHeight(shape({ beforeInfo: zh(29) }))).toBe(710);
    expect(miniAppEmbedHeight(shape({ beforeInfo: zh(30) }))).toBe(730); // 562 + 86
    expect(miniAppEmbedHeight(shape({ beforeInfo: zh(60) }))).toBe(760); // 590 + 86
    expect(miniAppEmbedHeight(shape({ beforeInfo: "a".repeat(58) }))).toBe(710);
    expect(miniAppEmbedHeight(shape({ title: zh(15) }))).toBe(710);
    expect(miniAppEmbedHeight(shape({ title: zh(16) }))).toBe(740); // 572 + 86
  });

  it("adds a row for tags that wrap on a phone", () => {
    expect(
      miniAppEmbedHeight(
        shape({
          participation: "direct",
          humanCheck: true,
          tags: ["无需口令", "拼手气 · 微信同款", "需人机验证"],
        }),
      ),
    ).toBe(760); // 664 at 325px wide
  });

  it("writes the height into the 社区's embed code", () => {
    expect(forumMiniAppEmbed("id", "周末红包", 700)).toContain('height="700"');
  });
});
