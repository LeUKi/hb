import { describe, expect, it } from "vitest";
import {
  activityImagePresentation,
  activityImageUrl,
  createActivityImageEmbed,
  encodeActivityEmoji,
  isImageTimeZone,
  type PublicActivity,
  renderActivityImage,
} from "../src";

const now = "2026-10-13T08:00:00.000Z";

function activity(extra: Partial<PublicActivity> = {}): PublicActivity {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    title: "红包 <script>alert(1)</script>",
    rewardType: "ldc",
    participationMode: "password",
    status: "active",
    author: {
      id: "user-1",
      username: "alice",
      displayName: "Alice & Bob",
      avatarUrl: null,
      accountTier: "standard",
    },
    forceDedicated: false,
    topicUrl: null,
    openedAt: now,
    deadlineAt: null,
    quantity: { mode: "exact", total: 3, claimed: 1, remaining: 2 },
    reward: {
      mode: "fixed",
      totalAmount: "3.00",
      unitAmount: "1.00",
      count: 3,
    },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo: "",
    paymentMode: "simulation",
    ...extra,
  };
}

describe("activity image renderer", () => {
  it("renders active, public fallback and claimed states without demo data", () => {
    const active = renderActivityImage(
      activityImagePresentation({
        activity: activity(),
        viewer: { kind: "eligible", action: "claim" },
        updatedAt: now,
        now,
        instanceId: "one",
      }),
    );
    expect(active).toContain('data-state="active"');
    expect(active).not.toContain("prefers-reduced-motion");
    expect(active).toContain("剩余 2 份");
    expect(active).toContain(">开<");
    expect(active).not.toContain("未登录");
    expect(active).not.toContain("18.88");
    expect(active).toContain("红包 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(active).toContain(
      "Alice &amp; Bob 的活动红包图片；状态：开；数量：剩余 2 份",
    );

    const fallback = renderActivityImage(
      activityImagePresentation({
        activity: activity(),
        publicFallback: true,
        updatedAt: now,
        now,
        instanceId: "fallback",
      }),
    );
    expect(fallback).toContain('data-state="neutral"');
    expect(fallback).toContain(">查看活动<");
    expect(fallback).not.toContain("剩余");
    expect(fallback).not.toContain("数据截至");
    expect(fallback).not.toContain("data-updated-at");
    expect(fallback).not.toContain("数据已过期");

    const claimed = renderActivityImage(
      activityImagePresentation({
        activity: activity(),
        viewer: {
          kind: "claimed",
          amount: "1.00",
          claimedAt: now,
          paymentStatus: "reconciling",
        },
        updatedAt: now,
        now,
        instanceId: "claimed",
      }),
    );
    expect(claimed).toContain(
      "M10 326c72 40 138.6 60 200 60s128-20 200-60v202c0 13.3-10.7 24-24 24H34c-13.3 0-24-10.7-24-24Z",
    );
    expect(claimed).toContain('fill="#f6efdf"');
    expect(claimed).toContain(".prize{fill:#168045");
    expect(claimed).toContain("+1.00 LDC");
    expect(claimed).toContain("正在核对原订单");
    expect(claimed).toContain("1200ms cubic-bezier(.2,.75,.2,1) 250ms");
    expect(claimed).not.toContain("prefers-reduced-motion");
    expect(claimed).toContain("650ms ease-out 1150ms");
    expect(claimed).toContain("领取于");
    expect(claimed).toContain(
      "Alice &amp; Bob 的活动红包图片；状态：正在核对原订单；金额：+1.00 LDC；领取时间：2026-10-13 16:00:00 · 北京时间",
    );
  });

  it("renders draw states and isolates animation ids", () => {
    const draw = activity({
      draw: {
        state: "waiting",
        deadlineAt: now,
        closedAt: null,
        reason: null,
        registeredCount: 4,
        winnerCount: null,
      },
      quantity: { mode: "exact", total: 8, claimed: 5, remaining: 3 },
    });
    const registered = renderActivityImage(
      activityImagePresentation({
        activity: draw,
        viewer: { kind: "registered", registeredAt: now },
        updatedAt: now,
        now,
        instanceId: "draw-a",
      }),
    );
    const drawing = renderActivityImage(
      activityImagePresentation({
        activity: draw,
        viewer: { kind: "drawing" },
        updatedAt: now,
        now,
        instanceId: "draw-b",
      }),
    );
    expect(registered).toContain("已报名，等待开奖");
    expect(drawing).toContain("开奖中");
    const publicDraw = renderActivityImage(
      activityImagePresentation({
        activity: draw,
        viewer: { kind: "eligible", action: "register" },
        updatedAt: now,
        now,
        instanceId: "draw-public",
      }),
    );
    expect(publicDraw).toContain("已报名 4 人");
    expect(publicDraw).not.toContain("已报名 5 / 8");

    const drawSummary = draw.draw;
    expect(drawSummary).toBeTruthy();
    const settlingPublic = renderActivityImage(
      activityImagePresentation({
        activity: activity({
          ...draw,
          status: "ended",
          draw: { ...drawSummary, state: "settling" },
        }),
        viewer: { kind: "public" },
        updatedAt: now,
        now,
        instanceId: "draw-settling",
      }),
    );
    expect(settlingPublic).toContain('data-state="drawing"');
    expect(settlingPublic).toContain("开奖中");
    expect(settlingPublic).not.toContain("已结束");
    expect(registered).toContain("@keyframes rp-draw-a-fade-in");
    expect(drawing).toContain("@keyframes rp-draw-b-fade-in");
    expect(drawing).not.toContain("rp-draw-a-fade-in");
  });

  it("scopes every inline style to the SVG instance", () => {
    const svg = renderActivityImage(
      activityImagePresentation({
        activity: activity(),
        viewer: { kind: "eligible", action: "claim" },
        updatedAt: now,
        now,
        instanceId: "scope-one",
      }),
    );
    expect(svg).toContain('data-scope="rp-scope-one"');
    expect(svg).toContain('svg[data-scope="rp-scope-one"] .packet');
    expect(svg).toContain("@keyframes rp-scope-one-fade-in");
    expect(svg).not.toMatch(
      /^[ \t]*\.(packet|sender|title-line|seal|data-row|snapshot-time|gold-particle|open-upper|claimed-result)\s*[,{]/m,
    );
    expect(svg).not.toMatch(/<style>\s*text\{/);
  });

  it("keeps a blank neutral placeholder free of invented metadata", () => {
    const svg = renderActivityImage({
      title: "",
      sender: "",
      state: "neutral",
      sealLabel: "",
      updatedAt: new Date(0),
      instanceId: "home-neutral",
    });
    expect(svg).toContain('data-state="neutral"');
    expect(svg).not.toContain("未命名活动");
    expect(svg).not.toContain("活动发起人");
    expect(svg).not.toContain("data-updated-at");
    expect(svg).not.toContain("数据截至");
    expect(svg).toContain("活动红包图片");
    expect(svg).not.toContain("状态：");
  });

  it("validates timezone and creates embed code", () => {
    expect(isImageTimeZone("Asia/Shanghai")).toBe(true);
    expect(isImageTimeZone("UTC")).toBe(true);
    expect(isImageTimeZone("America/New_York")).toBe(true);
    expect(isImageTimeZone("Etc/GMT+8")).toBe(true);
    expect(isImageTimeZone("+08:00")).toBe(false);
    expect(isImageTimeZone("<script>")).toBe(false);
    expect(
      activityImageUrl(
        "550e8400-e29b-41d4-a716-446655440000",
        "https://hb.example.com",
        {
          timeZone: "UTC",
          fallback: true,
        },
      ),
    ).toBe(
      `https://hb.example.com/e/${encodeActivityEmoji("550e8400-e29b-41d4-a716-446655440000")}/live.svg?fallback=public&tz=UTC`,
    );
    const emoji = encodeActivityEmoji("550e8400-e29b-41d4-a716-446655440000");
    const href = `https://hb.example.com/e/${emoji}`;
    const embed = createActivityImageEmbed({
      imageHref: new URL(`${href}/live.svg`).href,
      title: "红包",
      sender: "Alice",
    });
    expect(embed).toContain("<picture>");
    expect(embed).toContain('type="image/svg+xml"');
    expect(embed).not.toContain("prefers-reduced-motion");
    expect(embed).not.toContain("motion=reduced");
    expect(embed.match(/<source /g)).toHaveLength(1);
    expect(embed).toContain(" 1x");
    expect(embed).toContain(
      '<img width="420" height="560" alt="Alice 的活动红包：红包">',
    );
    expect(embed).not.toMatch(/<img\b[^>]*\bsrc(?:set)?\s*=/);
    expect(embed).not.toContain("fallback=public");
    expect(embed).toContain('alt="Alice 的活动红包：红包"');
    expect(embed).toMatch(/^<center>\n {2}<picture>/);
    expect(embed).toMatch(/<\/picture>\n<\/center>$/);
    expect(embed).not.toMatch(/<\/?a(?:\s|>)/);
    expect(embed).toContain(`srcset="${href}/live.svg 1x"`);
    expect(embed).not.toContain(encodeURIComponent(emoji));
  });

  it("keeps reserved URL escapes and HTML attributes safe in readable embeds", () => {
    const href = `https://hb.example.com/e/${encodeActivityEmoji("550e8400-e29b-41d4-a716-446655440000")}`;
    const input = {
      imageHref: `${href}/live.svg?tz=Etc%2FGMT%2B8&x=%26%2F%22%20`,
      title: '"><script>alert(1)</script>',
      sender: 'Alice & "Bob"',
    };
    const embed = createActivityImageEmbed(input);
    expect(embed).toContain("?tz=Etc%2FGMT%2B8&amp;x=%26%2F%22%20 1x");
    expect(embed).not.toContain("<script>");
    expect(embed).toContain("&quot;&gt;&lt;script&gt;");
    expect(embed).toContain("Alice &amp; &quot;Bob&quot;");
    expect(() =>
      createActivityImageEmbed({ ...input, imageHref: "javascript:alert(1)" }),
    ).toThrow(TypeError);
  });
});
