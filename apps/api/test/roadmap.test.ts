import { env } from "cloudflare:test";
import type {
  AdminAuditEntry,
  RoadmapDetail,
  RoadmapItem,
  RoadmapList,
  RoadmapSummary,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app";
import type { ApiBindings } from "../src/env";
import { type Actor, actor, bindings, origin } from "./code-fixtures";

// 施工中 (docs/roadmap-design.md): asking, voting, one's own changed or taken
// back until begun, and the 站长 running it from 网站管理 with 操作记录.

let owner: Actor;
let ownerEnv: ApiBindings;

beforeEach(async () => {
  owner = await actor();
  ownerEnv = { ...bindings, ADMIN_LINUX_DO_IDS: owner.externalId };
});

async function call<T>(
  method: string,
  path: string,
  user: Actor | null,
  json?: unknown,
) {
  const response = await app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        ...(user
          ? { Cookie: user.cookie, "X-CSRF-Token": user.csrf, Origin: origin }
          : {}),
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    },
    ownerEnv,
  );
  return { status: response.status, body: (await response.json()) as T };
}

const ask = async (user: Actor, title: string, detail = "") =>
  (
    await call<{ item: RoadmapItem }>("POST", "/roadmap/items", user, {
      title,
      detail,
    })
  ).body.item;

const act = (id: string, json: unknown) =>
  call<{ item: RoadmapItem; error?: { code: string } }>(
    "POST",
    `/admin/roadmap/items/${id}`,
    owner,
    json,
  );

describe("施工中", () => {
  it("takes a request with its asker's vote; votes toggle once a person; 最热 and 最新 order them; guests read it", async () => {
    const a = await actor();
    const b = await actor();
    const first = await ask(a, "红包记录能按金额排序", "发得多了想看看");
    expect(first).toMatchObject({
      status: "request",
      votes: 1,
      voted: true,
      mine: true,
      byOwner: false,
    });
    const second = await ask(b, "深色模式");
    const up = await call<{ votes: number; voted: boolean }>(
      "PUT",
      `/roadmap/items/${second.id}/vote`,
      a,
      { voted: true },
    );
    expect(up.body).toEqual({ votes: 2, voted: true });
    // Again: still one.
    expect(
      (
        await call<{ votes: number }>(
          "PUT",
          `/roadmap/items/${second.id}/vote`,
          a,
          { voted: true },
        )
      ).body.votes,
    ).toBe(2);
    const hot = await call<RoadmapList>(
      "GET",
      "/roadmap/items?status=request&sort=hot",
      null,
    );
    expect(hot.body.items.map((item) => item.title).slice(0, 2)).toEqual([
      "深色模式",
      "红包记录能按金额排序",
    ]);
    expect(hot.body.items[0]?.voted).toBe(false);
    const fresh = await call<RoadmapList>(
      "GET",
      "/roadmap/items?status=request&sort=new",
      a,
    );
    expect(fresh.body.items[0]?.title).toBe("深色模式");
    expect(fresh.body.items[0]?.voted).toBe(true);
    const down = await call<{ votes: number; voted: boolean }>(
      "PUT",
      `/roadmap/items/${second.id}/vote`,
      a,
      { voted: false },
    );
    expect(down.body).toEqual({ votes: 1, voted: false });
    expect(
      (await call("POST", "/roadmap/items", a, { title: "  ", detail: "" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("PUT", `/roadmap/items/${second.id}/vote`, null, {
          voted: true,
        })
      ).status,
    ).toBe(403);
  });

  it("finds the like as one types, and lets its asker change or take back theirs until the 站长 begins it", async () => {
    const a = await actor();
    const b = await actor();
    const mine = await ask(a, "领取记录能导出成表格");
    await ask(b, "完全不相干的东西");
    const like = await call<RoadmapList>(
      "GET",
      `/roadmap/similar?q=${encodeURIComponent("领取记录导出表格")}`,
      b,
    );
    expect(like.body.items.map((item) => item.title)).toEqual([
      "领取记录能导出成表格",
    ]);
    const changed = await call<{ item: RoadmapItem }>(
      "PUT",
      `/roadmap/items/${mine.id}`,
      a,
      { title: "领取记录导出成表格", detail: "" },
    );
    expect(changed.body.item.title).toBe("领取记录导出成表格");
    expect(
      (
        await call("PUT", `/roadmap/items/${mine.id}`, b, {
          title: "改别人的",
          detail: "",
        })
      ).status,
    ).toBe(404);
    expect((await act(mine.id, { action: "start" })).status).toBe(200);
    const late = await call<{ error: { code: string } }>(
      "DELETE",
      `/roadmap/items/${mine.id}`,
      a,
    );
    expect(late.body.error.code).toBe("ROADMAP_BEGUN");
    const other = await ask(a, "要删的");
    expect((await call("DELETE", `/roadmap/items/${other.id}`, a)).status).toBe(
      200,
    );
    expect((await call("GET", `/roadmap/items/${other.id}`, a)).status).toBe(
      404,
    );
  });

  it("is run by the 站长: 开工, 写进展, 完成, 不做, 退回, 合并 (votes once a person), 隐藏 — each in 操作记录", async () => {
    const a = await actor();
    const b = await actor();
    const one = await ask(a, "排行榜加周榜");
    const two = await ask(b, "排行榜要周榜");
    await call("PUT", `/roadmap/items/${one.id}/vote`, b, { voted: true });
    // Merged: b's vote counted once, two out of every list.
    const merged = await act(two.id, { action: "merge", into: one.id });
    expect(merged.status).toBe(200);
    const target = await call<RoadmapDetail>(
      "GET",
      `/roadmap/items/${one.id}`,
      null,
    );
    expect(target.body.item.votes).toBe(2);
    expect((await call("GET", `/roadmap/items/${two.id}`, null)).status).toBe(
      404,
    );
    await act(one.id, { action: "start" });
    await act(one.id, { action: "note", text: "在写周榜的查询" });
    let summary = await call<RoadmapSummary>("GET", "/roadmap", null);
    expect(summary.body.building.map((item) => item.title)).toContain(
      "排行榜加周榜",
    );
    expect(
      summary.body.building.find((item) => item.id === one.id)?.note?.text,
    ).toBe("在写周榜的查询");
    // A move its status does not allow is refused.
    expect((await act(one.id, { action: "start" })).body.error?.code).toBe(
      "ROADMAP_STATUS",
    );
    await act(one.id, { action: "done" });
    summary = await call<RoadmapSummary>("GET", "/roadmap", null);
    expect(summary.body.counts.done).toBeGreaterThanOrEqual(1);
    const done = await call<RoadmapList>(
      "GET",
      "/roadmap/items?status=done",
      null,
    );
    expect(done.body.items[0]?.id).toBe(one.id);
    // Done takes no votes.
    expect(
      (await call("PUT", `/roadmap/items/${one.id}/vote`, a, { voted: false }))
        .status,
    ).toBe(409);
    await act(one.id, { action: "back" });
    const three = await ask(a, "红包能换封面");
    await act(three.id, { action: "decline", reason: "先不做图片上传" });
    const declined = await call<RoadmapList>(
      "GET",
      "/roadmap/items?status=declined",
      null,
    );
    expect(declined.body.items[0]).toMatchObject({
      id: three.id,
      reason: "先不做图片上传",
    });
    await act(three.id, { action: "hide" });
    expect(
      (
        await call<RoadmapList>("GET", "/roadmap/items?status=declined", null)
      ).body.items.map((item) => item.id),
    ).not.toContain(three.id);
    const admin = await call<RoadmapList & { counts: Record<string, number> }>(
      "GET",
      "/admin/roadmap?status=declined",
      owner,
    );
    expect(admin.body.items.find((item) => item.id === three.id)?.hidden).toBe(
      true,
    );
    const created = await call<{ item: RoadmapItem }>(
      "POST",
      "/admin/roadmap/items",
      owner,
      { title: "施工页", detail: "", status: "building" },
    );
    expect(created.body.item).toMatchObject({
      status: "building",
      byOwner: true,
      votes: 0,
    });
    // Not the 站长: refused.
    expect(
      (
        await call("POST", `/admin/roadmap/items/${three.id}`, a, {
          action: "unhide",
        })
      ).status,
    ).toBe(403);
    const audit = await call<{ items: AdminAuditEntry[] }>(
      "GET",
      "/admin/audit?type=roadmap",
      owner,
    );
    expect(
      audit.body.items
        .map((entry) => entry.roadmap)
        .filter((entry) => entry?.id === one.id || entry?.id === two.id)
        .map((entry) => `${entry?.action} ${entry?.reason ?? ""}`.trim())
        .reverse(),
    ).toEqual([
      "merge 排行榜加周榜",
      "start",
      "note 在写周榜的查询",
      "done",
      "back",
    ]);
  });

  it("keeps the silenced from asking", async () => {
    const quiet = await actor();
    await env.DB.prepare("UPDATE users SET silenced = 1 WHERE id = ?")
      .bind(quiet.id)
      .run();
    const refused = await call<{ error: { code: string; message: string } }>(
      "POST",
      "/roadmap/items",
      quiet,
      { title: "想要", detail: "" },
    );
    expect(refused.body.error).toEqual({
      code: "ROADMAP_SILENCED",
      message: "你的账号现在不能提需求。",
    });
  });
});
