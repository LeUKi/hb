import { env } from "cloudflare:test";
import { encodeActivityEmoji } from "@hb/contracts";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { activities, judges, pointsSystems, tipCards } from "../src/db/schema";
import { drawPreview, plainText } from "../src/site/preview";
import { actor, origin } from "./code-fixtures";

// Link previews (docs/link-preview-design.md §2): what anyone sees without
// signing in, and nothing that changes as a 红包 runs.

const bindings = { ...env, APP_ORIGIN: origin };

async function preview(kind: string, key: string) {
  const response = await app.request(
    `${origin}/api/site/preview/${kind}/${encodeURIComponent(key)}`,
    {},
    bindings,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/**
 * A 红包 row, open. Opening for real sets its random version and wants its
 * 口令 and shares (0037, 0040), so this one reads as from before then: its
 * 🎲 is tested on drawPreview itself.
 */
async function hongbao(
  authorId: string,
  config: object,
  extra: Partial<typeof activities.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await createDb(env.DB)
    .insert(activities)
    .values({
      id,
      authorId,
      creationRequestId: crypto.randomUUID(),
      creationDigest: "test",
      title: "周末红包",
      paymentMode: "simulation",
      rewardType: "ldc",
      forceDedicated: false,
      allocation: "sequential",
      config: JSON.stringify({
        ...config,
        participationMode: extra.participationMode ?? "password",
      }),
      totalCount: 20,
      claimedCount: 3,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      deadline: now + 86_400_000,
      ...extra,
    });
  return id;
}

describe("/api/site/preview", () => {
  it("says whose 红包, its title and how to take part, never its counts", async () => {
    const author = await actor();
    const id = await hongbao(author.id, {
      money: { mode: "random", totalAmount: "8.88", count: 20 },
    });
    const code = encodeActivityEmoji(id);
    const page = await preview("activity", code);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({
      title: `Code ${author.id.slice(0, 4)}的红包 · 周末红包`,
      description: "口令红包 · 拼手气。打开链接，输入口令领取。",
      tab: "周末红包",
    });
    expect(JSON.stringify(page.body)).not.toMatch(/8\.88|份|剩/);
    // A bare UUID reads the same.
    expect((await preview("activity", id)).body).toEqual(page.body);
    // Opened before today's algorithm: its 🎲 has no data, so no words.
    expect((await preview("draw", code)).status).toBe(404);

    const draw = await hongbao(
      author.id,
      { money: { mode: "timed_draw" } },
      { participationMode: "direct" },
    );
    expect((await preview("activity", draw)).body.description).toBe(
      "无需口令 · 限时开奖。打开链接，登录后报名。",
    );
    const coded = await hongbao(
      author.id,
      { money: { mode: "code" } },
      {
        participationMode: "code",
        forceDedicated: true,
        joinSquare: true,
        funding: "balance",
      },
    );
    expect((await preview("activity", coded)).body.description).toBe(
      "代码判定红包。打开链接，按红包页的提示参与。",
    );
  });

  it("says a 🎲 only where it has data", () => {
    const opened = {
      title: "周末红包",
      allocation: "sequential",
      randomVersion: 2,
      openedAt: 1,
    };
    expect(drawPreview({ ...opened, mode: "random" })).toEqual({
      title: "发放数据 · 周末红包",
      description:
        "每份的金额在开放时就封存好了，结束后谁都能重算一遍，核对每份金额。",
      tab: "发放数据 · 周末红包",
    });
    expect(drawPreview({ ...opened, mode: "timed_draw" })?.title).toBe(
      "开奖数据 · 周末红包",
    );
    expect(
      drawPreview({ ...opened, mode: "custom", allocation: "random" })?.title,
    ).toBe("发放数据 · 周末红包");
    for (const row of [
      { ...opened, mode: "fixed" },
      { ...opened, mode: "custom" },
      { ...opened, mode: "code" },
      { ...opened, mode: "random", randomVersion: null },
      { ...opened, mode: "random", openedAt: null },
    ])
      expect(drawPreview(row), JSON.stringify(row)).toBeNull();
  });

  it("says a 三方积分's 介绍 as the words it shows", () => {
    expect(
      plainText(
        "## 额度\n**Payload** 是 [某 API](https://api.example.com/) 的额度，见 ![图](x.png)。\n- 可用于 `调用`",
      ),
    ).toBe("额度\nPayload 是 某 API 的额度，见 图。\n可用于 调用");
  });

  it("has nothing to say of a deleted 红包, a stranger's 判定器 or a draft 三方积分", async () => {
    const author = await actor();
    const db = createDb(env.DB);
    const now = Date.now();
    const deleted = await hongbao(author.id, {}, { deletedAt: now });
    expect((await preview("activity", deleted)).status).toBe(404);
    expect((await preview("activity", "not-a-code")).status).toBe(404);
    expect((await preview("nothing", "x")).status).toBe(404);

    const unlisted = crypto.randomUUID();
    await db.insert(judges).values({
      id: unlisted,
      authorId: author.id,
      name: "没上广场",
      createdAt: now,
      updatedAt: now,
    });
    const draft = crypto.randomUUID();
    await db.insert(pointsSystems).values({
      id: draft,
      ownerId: author.id,
      status: "draft",
      name: "草稿积分",
      unit: "分",
      step: 1,
      issuerName: "某站",
      baseUrl: "https://points.example.com",
      host: "points.example.com",
      createdAt: now,
      updatedAt: now,
    });
    for (const [kind, key] of [
      ["judge", unlisted],
      ["points", draft],
      ["tip", "NOPE"],
    ] as const) {
      expect((await preview(kind, key)).status).toBe(404);
    }
  });

  it("says a 判定器 in the 广场, a 三方积分 once online and a 打赏卡", async () => {
    const author = await actor();
    const db = createDb(env.DB);
    const now = Date.now();
    const judge = crypto.randomUUID();
    await db.insert(judges).values({
      id: judge,
      authorId: author.id,
      name: "五子棋",
      description: "两个人下一盘，赢的领。",
      codePublic: "always",
      outdatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    // Into the 广场 (its triggers let a 判定器 in only once made).
    await env.DB.prepare("UPDATE judges SET listed_at = ? WHERE id = ?")
      .bind(now, judge)
      .run();
    expect((await preview("judge", judge)).body).toEqual({
      title: "五子棋 · 判定器",
      description: `作者已把它标为过时。@code_${author.id.slice(0, 8)} 的判定器。两个人下一盘，赢的领。`,
      tab: "判定器",
    });

    const points = crypto.randomUUID();
    await db.insert(pointsSystems).values({
      id: points,
      ownerId: author.id,
      status: "online",
      name: "鱼币",
      unit: "币",
      step: 1,
      issuerName: "鱼塘",
      baseUrl: "https://points.example.com",
      host: "points.example.com",
      createdAt: now,
      updatedAt: now,
    });
    expect((await preview("points", points)).body).toEqual({
      title: "鱼币 · 三方积分",
      description: "鱼塘 发行的积分，大家可以用它发红包。",
      tab: "三方积分",
    });

    const card = `T${crypto.randomUUID().slice(0, 7)}`;
    await db.insert(tipCards).values({
      id: crypto.randomUUID(),
      code: card,
      ownerId: author.id,
      name: "我的卡",
      style: "simple",
      palette: "lake",
      amounts: "[]",
      createdAt: now,
      updatedAt: now,
    });
    expect((await preview("tip", card)).body).toEqual({
      title: `打赏 Code ${author.id.slice(0, 4)}`,
      description: `@code_${author.id.slice(0, 8)} 的打赏卡，打开链接就能打赏。`,
      tab: null,
    });
  });
});
