import { describe, expect, it } from "vitest";
import {
  ACTIVITY_IMAGE_EMBED_SIZES,
  ACTIVITY_IMAGE_HEIGHT,
  ACTIVITY_IMAGE_WIDTH,
  type ActivityImageViewerState,
  activityImageInput,
  activityImageUrl,
  createActivityImageEmbed,
  encodeActivityEmoji,
  FORUM_POST_URL,
  isImageTimeZone,
  type PublicActivity,
  renderActivityImage,
  renderUnavailableActivityImage,
} from "../src";

const id = "550e8400-e29b-41d4-a716-446655440000";
const code = encodeActivityEmoji(id);
const renderedAt = new Date("2026-10-13T08:00:00.000Z");

function activity(extra: Partial<PublicActivity> = {}): PublicActivity {
  return {
    id,
    title: "红包 <script>alert(1)</script>",
    rewardType: "ldc",
    participationMode: "password",
    status: "active",
    author: {
      id: "user-1",
      username: "alice",
      displayName: "Alice & Bob",
      avatarUrl: "https://cdn.example.com/avatars/alice.png",
    },
    forceDedicated: false,
    topicUrl: null,
    openedAt: renderedAt.toISOString(),
    deadlineAt: "2026-10-14T08:00:00.000Z",
    quantity: { mode: "exact", total: 3, claimed: 1, remaining: 2 },
    reward: {
      mode: "fixed",
      totalAmount: "3.00",
      unitAmount: "1.00",
      count: 3,
    },
    beforeInfo: "SECRET-NOTE",
    paymentMode: "simulation",
    ...extra,
  };
}

const draw = (state: NonNullable<PublicActivity["draw"]>["state"]) =>
  ({
    state,
    deadlineAt: "2026-10-14T08:00:00.000Z",
    closedAt: null,
    reason: null,
    registeredCount: 4,
    winnerCount: null,
  }) satisfies PublicActivity["draw"];

function image(
  viewer: ActivityImageViewerState,
  extra: Partial<PublicActivity> = {},
  timeZone?: string,
) {
  return renderActivityImage(
    activityImageInput({
      activity: activity(extra),
      viewer,
      renderedAt,
      timeZone,
    }),
  );
}

/** The seal's words, or null when there is no seal. */
const sealOf = (svg: string) =>
  /class="glyph[^"]*"[^>]*>([^<]+)</.exec(svg)?.[1] ?? null;

describe("activity image", () => {
  it("draws a running 红包 for a guest and for a signed-in viewer", () => {
    const guest = image({ kind: "public" });
    expect(sealOf(guest)).toBe("查看");
    expect(guest).toContain("剩余 2 份");
    expect(guest).toContain("Alice &amp; Bob的红包");
    expect(guest).toContain("&lt;script&gt;");
    expect(guest).not.toContain("<script>");
    expect(guest).toContain(`class="code">${code}</text>`);
    expect(guest).toContain("数据可能过期，打开红包查看最新");
    expect(guest).not.toContain('filter="url(#muted)"');
    expect(sealOf(image({ kind: "eligible", action: "claim" }))).toBe("开");
    expect(
      sealOf(
        image(
          { kind: "eligible", action: "register" },
          { draw: draw("waiting") },
        ),
      ),
    ).toBe("报");
    expect(image({ kind: "public" }, { draw: draw("waiting") })).toContain(
      "已报名 4 人",
    );
    expect(
      image(
        { kind: "public" },
        { quantity: { mode: "fuzzy", level: "limited" } },
      ),
    ).toContain("余量有限");
    expect(
      image(
        { kind: "public" },
        {
          quantity: { mode: "fuzzy", level: "plenty" },
          draw: { ...draw("waiting"), registeredCount: null },
        },
      ),
    ).toContain("限时开奖");
  });

  it("draws a draft as 未开放 for everyone: the cover as it will be, the seal grey", () => {
    const draft = {
      status: "draft",
      openedAt: null,
      deadlineAt: null,
    } as const;
    for (const viewer of [
      { kind: "public" },
      { kind: "eligible", action: "claim" },
    ] as const) {
      const svg = image(viewer, draft);
      expect(sealOf(svg)).toBe("未开放");
      expect(svg).toContain("还没开放");
      expect(svg).toContain('fill="url(#pewter)"');
      expect(svg).not.toContain('filter="url(#muted)"');
    }
    const lacquer = image(
      { kind: "public" },
      { ...draft, participationMode: "code" },
    );
    expect(sealOf(lacquer)).toBe("未开放");
    expect(lacquer).toContain('fill="url(#steel)"');
  });

  it("says when a timed draft opens, in the viewer's zone (定时开放)", () => {
    const draft = {
      status: "draft",
      openedAt: null,
      deadlineAt: null,
    } as const;
    // renderedAt is 16:00 in Shanghai.
    const at = (iso: string) =>
      image({ kind: "public" }, { ...draft, scheduledOpenAt: iso });
    expect(at("2026-10-13T12:00:00.000Z")).toContain("今天 20:00 开放");
    expect(at("2026-10-14T01:30:00.000Z")).toContain("明天 09:30 开放");
    expect(at("2026-10-20T12:00:00.000Z")).toContain("10月20日 20:00 开放");
    expect(at("2026-10-13T12:00:00.000Z")).not.toContain("还没开放");
  });

  it("opens for the viewer who took part, with the payment and when", () => {
    const claimed = image({
      kind: "claimed",
      amount: "1.00",
      claimedAt: "2026-10-13T07:59:30.000Z",
      paymentStatus: "pending",
    });
    // No seal at rest: only the one that pops as it opens.
    expect(claimed.match(/class="glyph/g)).toHaveLength(1);
    expect(claimed).toMatch(/<g class="pop motion">/);
    expect(claimed).toContain("你已领取");
    expect(claimed).toContain("<tspan>+1.00</tspan>");
    expect(claimed).toContain("付款处理中");
    expect(claimed).toContain("领取于 10月13日 15:59:30");
    expect(claimed).toContain('class="flap motion"');
    expect(claimed).toContain("数据可能过期");

    const confirmed = image({
      kind: "claimed",
      amount: "1.00",
      claimedAt: "2026-10-13T07:59:30.000Z",
      paymentStatus: "confirmed",
    });
    expect(confirmed).toContain("已发放");
    expect(confirmed).not.toContain("数据可能过期");
    expect(
      image({
        kind: "claimed",
        amount: "1.00",
        claimedAt: renderedAt,
        paymentStatus: "reconciling",
      }),
    ).toContain("正在核对原订单");
    expect(
      image({
        kind: "claimed",
        amount: "1.00",
        claimedAt: renderedAt,
        paymentStatus: "attention",
      }),
    ).toContain("需要关注");

    const won = image(
      { kind: "claimed", amount: "2.50", claimedAt: renderedAt },
      { draw: draw("completed"), status: "ended" },
    );
    expect(won).toContain("你中奖了");
    expect(won).toContain("开奖于 10月13日 16:00:00");
    expect(won).toMatch(/class="glyph"[^>]*>报</);
  });

  it("draws waiting, the draw and the end", () => {
    const registered = image({ kind: "registered" }, { draw: draw("waiting") });
    expect(sealOf(registered)).toBe("已报名");
    expect(registered).toContain("已报名，等待开奖");
    const drawing = image({ kind: "drawing" }, { draw: draw("settling") });
    expect(sealOf(drawing)).toBe("开奖中");
    expect(drawing).toContain("正在开奖");
    expect(sealOf(image({ kind: "public" }, { draw: draw("settling") }))).toBe(
      "开奖中",
    );

    const lost = image(
      { kind: "not_won" },
      { draw: draw("completed"), status: "ended" },
    );
    expect(sealOf(lost)).toBe("未中");
    expect(lost).toContain("本次未中奖");
    expect(lost).toContain('filter="url(#muted)"');
    expect(lost).not.toContain("数据可能过期");

    const soldOut = {
      status: "ended" as const,
      quantity: { mode: "exact" as const, total: 3, claimed: 3, remaining: 0 },
    };
    for (const viewer of [{ kind: "public" }, { kind: "ended" }] as const) {
      const ended = image(viewer, soldOut);
      expect(sealOf(ended)).toBe("完");
      expect(ended).toContain("红包已领完");
      expect(ended).toContain('filter="url(#muted)"');
    }
    expect(
      image(
        { kind: "ended" },
        { status: "ended", deadlineAt: "2026-10-13T07:00:00.000Z" },
      ),
    ).toContain("红包已过期");
    expect(image({ kind: "ended" }, { status: "ended" })).toContain(
      "红包已提前结束",
    );
    expect(
      image({ kind: "public" }, { status: "ended", draw: draw("empty") }),
    ).toContain("无人报名");
    expect(
      image({ kind: "public" }, { status: "ended", draw: draw("completed") }),
    ).toContain("已开奖");
  });

  it("draws a 代码判定红包 in black lacquer and gold, and graphite once over", () => {
    const coded = {
      participationMode: "code" as const,
      funding: "balance" as const,
    };
    for (const viewer of [
      { kind: "public" },
      { kind: "eligible", action: "claim" },
      { kind: "claimed", amount: "0.33", claimedAt: renderedAt, fish: true },
    ] as const) {
      const svg = image(viewer, coded);
      expect(svg).toContain('fill="url(#lacquer)"');
      expect(svg).toContain('fill="url(#lacquer-fret)"');
      expect(svg).toContain('stroke="url(#rim-gold)"');
      expect(svg).toContain("fill: url(#title-gold)");
      expect(svg).toContain("#24180f");
      expect(svg).not.toContain("#d93c33");
      expect(svg).not.toContain("url(#red)");
      expect(svg).not.toContain('filter="url(#muted)"');
    }
    // The opening folds a lacquer flap, not a red one.
    expect(
      image(
        { kind: "claimed", amount: "0.33", claimedAt: renderedAt, fish: true },
        coded,
      ),
    ).toMatch(/<g class="flap motion">\s*<path[^>]*fill="url\(#lacquer\)"/);
    // The gold runs down a two-line title as one: one <text>, two lines.
    const long = { ...coded, title: "很长".repeat(14) };
    expect(image({ kind: "public" }, long)).toMatch(
      /<text class="title"><tspan[^>]*>[^<]+<\/tspan><tspan[^>]*>[^<]+<\/tspan><\/text>/,
    );
    expect(image({ kind: "public" }, { title: "很长".repeat(14) })).toMatch(
      /<text x="210" y="157.0" class="title">[^<]+<\/text><text x="210" y="195.0" class="title">/,
    );

    // Black made darker still reads as running: graphite with a silver
    // 回纹, a steel seal.
    for (const viewer of [{ kind: "public" }, { kind: "ended" }] as const) {
      const ended = image(viewer, { ...coded, status: "ended" });
      expect(sealOf(ended)).toBe("完");
      expect(ended).not.toContain('filter="url(#muted)"');
      expect(ended).toContain('fill="url(#graphite)"');
      expect(ended).toContain("#5a5e65");
      expect(ended).toContain('fill="url(#graphite-fret)"');
      expect(ended).toContain('stroke="#d6dce4"');
      expect(ended).toContain('stroke="#cfcac2"');
      expect(ended).toContain('fill="url(#steel)"');
      expect(ended).toContain("#5f646b");
      expect(ended).not.toContain("url(#lacquer)");
      expect(ended).not.toContain("url(#pewter)");
    }
    // A red 红包 is as it was.
    const red = image({ kind: "public" });
    expect(red).toContain('fill="url(#red)"');
    expect(red).not.toContain("url(#lacquer)");
    expect(image({ kind: "ended" }, { status: "ended" })).toContain(
      'fill="url(#pewter)"',
    );
  });

  it("says when the 站长 stopped a 代码判定红包, and when its code paused claims", () => {
    const coded = {
      participationMode: "code" as const,
      funding: "balance" as const,
    };
    for (const viewer of [{ kind: "public" }, { kind: "ended" }] as const)
      expect(
        image(viewer, { ...coded, status: "ended", stopped: true }),
      ).toContain("红包已被站长停用");
    const judge = {
      protocol: 1,
      prompt: "输入 flag",
      fingerprint: "f".repeat(64),
      seedCommitment: "c".repeat(64),
      judged: 5,
    };
    expect(
      image(
        { kind: "public" },
        { ...coded, status: "ended", judge: { ...judge, stopped: true } },
      ),
    ).toContain("红包已被站长停用");

    const paused = (viewer: ActivityImageViewerState) =>
      renderActivityImage(
        activityImageInput({
          activity: activity(coded),
          viewer,
          renderedAt,
          paused: true,
        }),
      );
    // 开 is there but a faded, solid gold with no sheen; a guest's 查看
    // still offers a look.
    const eligible = paused({ kind: "eligible", action: "claim" });
    expect(eligible).toContain("红包的代码连续出错，暂停领取");
    expect(eligible).not.toContain("剩余 2 份");
    expect(sealOf(eligible)).toBe("开");
    expect(eligible).toContain('fill="url(#faded)"');
    expect(eligible).toContain('class="glyph faded"');
    expect(eligible).not.toContain('class="sheen"');
    expect(eligible).not.toContain('opacity=".6"');
    expect(eligible).toContain("数据可能过期");
    const guest = paused({ kind: "public" });
    expect(guest).toContain("红包的代码连续出错，暂停领取");
    expect(sealOf(guest)).toBe("查看");
    expect(guest).not.toContain("url(#faded)");
    expect(guest).toContain('class="sheen"');
    // The page's own read says it in `judge`.
    expect(
      image(
        { kind: "public" },
        { ...coded, judge: { ...judge, paused: true } },
      ),
    ).toContain("红包的代码连续出错，暂停领取");
    expect(image({ kind: "public" }, coded)).toContain("剩余 2 份");
  });

  it("writes times in the viewer's zone and never draws private or outside things", () => {
    expect(image({ kind: "public" })).toContain("数据截至 16:00:00");
    expect(image({ kind: "public" }, {}, "UTC")).toContain("数据截至 08:00:00");
    expect(image({ kind: "public" }, {}, "+08:00")).toContain(
      "数据截至 16:00:00",
    );
    const svg = image({
      kind: "claimed",
      amount: "1.00",
      claimedAt: renderedAt,
    });
    expect(svg).not.toContain("SECRET-NOTE");
    expect(svg).not.toContain("cdn.example.com");
    expect(svg).not.toContain("3.00");
    expect(svg).not.toMatch(/<script|<image|<foreignObject|href=/);
    expect(svg.match(/https?:\/\/[^"]+/g)).toEqual([
      "http://www.w3.org/2000/svg",
    ]);
  });

  it("draws a missing 红包 and a failed read", () => {
    expect(renderUnavailableActivityImage("missing")).toContain(
      "红包不存在，或链接已经失效",
    );
    expect(renderUnavailableActivityImage("error")).toContain(
      "图片读取失败，请稍后刷新",
    );
  });
});

describe("activity image address and embed code", () => {
  it("validates time zones", () => {
    expect(isImageTimeZone("Asia/Shanghai")).toBe(true);
    expect(isImageTimeZone("UTC")).toBe(true);
    expect(isImageTimeZone("America/New_York")).toBe(true);
    expect(isImageTimeZone("Etc/GMT+8")).toBe(true);
    expect(isImageTimeZone("+08:00")).toBe(false);
    expect(isImageTimeZone("<script>")).toBe(false);
  });

  it("keeps the emoji visible in the address", () => {
    expect(activityImageUrl(id, "https://hb.example.com")).toBe(
      `https://hb.example.com/🧧/${code}/🖼️.svg`,
    );
    expect(
      activityImageUrl(id, "https://hb.example.com/any/path", {
        timeZone: "Etc/GMT+8",
      }),
    ).toBe(`https://hb.example.com/🧧/${code}/🖼️.svg?tz=Etc%2FGMT%2B8`);
    expect(() => activityImageUrl(id, "ftp://hb.example.com")).toThrow(
      TypeError,
    );
    expect(() =>
      activityImageUrl(id, "https://user:secret@hb.example.com"),
    ).toThrow(TypeError);
  });

  it("writes the forum code linking where it is told (the 红包's page, or the site's post), named by the emoji code", () => {
    expect(
      createActivityImageEmbed({
        activityId: id,
        origin: "https://hb.example.com",
        sender: "小满",
        link: FORUM_POST_URL,
      }),
    ).toBe(
      [
        '<a href="https://linux.do/t/3033290">',
        `<picture><source type="image/svg+xml" srcset="https://hb.example.com/%F0%9F%A7%A7/${encodeURIComponent(code)}/%F0%9F%96%BC%EF%B8%8F.svg 1x"><img width="300" height="400" `,
        `alt="小满的红包：${code}"></picture>`,
        "</a>",
      ].join("\n"),
    );
    // Each size keeps the image's 3:4; the largest is the image's own.
    for (const size of ACTIVITY_IMAGE_EMBED_SIZES) {
      expect(size.width * 4).toBe(size.height * 3);
      expect(
        createActivityImageEmbed({
          activityId: id,
          origin: "https://hb.example.com",
          sender: "小满",
          link: FORUM_POST_URL,
          size,
        }),
      ).toContain(`<img width="${size.width}" height="${size.height}" `);
    }
    expect(ACTIVITY_IMAGE_EMBED_SIZES.at(-1)).toEqual({
      width: ACTIVITY_IMAGE_WIDTH,
      height: ACTIVITY_IMAGE_HEIGHT,
    });
    const page = `https://hb.example.com/🧧/${code}`;
    expect(
      createActivityImageEmbed({
        activityId: id,
        origin: "https://hb.example.com",
        sender: "小满",
        link: page,
      }).split("\n")[0],
    ).toBe(
      // No emoji in a post's link (05 §5): a community iOS client was
      // reported to crash on one.
      `<a href="https://hb.example.com/%F0%9F%A7%A7/${encodeURIComponent(code)}">`,
    );
    const escaped = createActivityImageEmbed({
      activityId: id,
      origin: "https://hb.example.com",
      sender: '"><script>alert(1)</script>',
      link: page,
    });
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain(
      `alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;的红包：${code}"`,
    );
  });
});
