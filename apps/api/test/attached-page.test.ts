import {
  type ActivityInput,
  type AdminActivityDetail,
  type AdminAuditEntry,
  emptyActivityInput,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createActivity,
  getManagedActivity,
  getPublicActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import {
  type Actor,
  actor,
  bindings,
  give,
  origin,
  plus,
  rejects,
  settings,
} from "./code-fixtures";

// 附带网页 (docs/attached-page-design.md): who may give a 红包 one, the
// address as kept, fixed once opened, the switch, and the 站长's 停用.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1, page_enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
});

function withPage(pageUrl?: string): ActivityInput {
  const { rewardType: _type, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "附带网页的红包",
    rewardType: "ldc",
    funding: "balance",
    merchantId: "",
    participationMode: "direct",
    passwords: [],
    money: { mode: "fixed", totalAmount: "1.00", count: 2 },
    ...(pageUrl === undefined ? {} : { pageUrl }),
  };
}

const draft = (user: Actor, activity: ActivityInput) =>
  createActivity(bindings, user.id, {
    requestId: crypto.randomUUID(),
    activity,
  });

async function opened(pageUrl = "https://Puzzle.Example.com/题目?day=3#top") {
  const saved = await draft(author, withPage(pageUrl));
  return openActivity(bindings, saved.id, author.id, saved.version);
}

async function call<T>(method: string, path: string, user: Actor) {
  const response = await app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": user.csrf,
      },
    },
    { ...bindings, ADMIN_LINUX_DO_IDS: admin.externalId },
  );
  return {
    status: response.status,
    body: (await response.json()) as T & { error?: { code: string } },
  };
}

describe("附带网页", () => {
  it("keeps a PLUS sender's page as the URL standard writes it and shows it on the 红包 page", async () => {
    const activity = await opened();
    const url = "https://puzzle.example.com/%E9%A2%98%E7%9B%AE?day=3#top";
    expect(
      (await getManagedActivity(bindings, activity.id, author.id)).config,
    ).toMatchObject({ pageUrl: url });
    expect((await getPublicActivity(bindings, activity.id)).page).toEqual({
      url,
      host: "puzzle.example.com",
    });
    // None: no field at all, on the page or in the config.
    const plain = await draft(author, withPage(""));
    expect(plain.config.pageUrl).toBeUndefined();
    expect(
      (await getPublicActivity(bindings, plain.id, author.id)).page,
    ).toBeUndefined();
  });

  it("is refused without PLUS, while the switch is off, and for an address outside the rules", async () => {
    const other = await actor();
    await give(admin, other, "5.00");
    await rejects(
      draft(other, withPage("https://example.com/")),
      "PAGE_NOT_ALLOWED",
    );
    await settings({ page_enabled: 0 });
    await rejects(
      draft(author, withPage("https://example.com/")),
      "PAGE_PAUSED",
    );
    await settings({ page_enabled: 1 });
    await expect(
      draft(author, withPage("http://example.com/")),
    ).rejects.toMatchObject({
      code: "INVALID_ACTIVITY",
      message: "只能用 https:// 开头的地址",
    });
    // Adding one to a draft later asks the same.
    const plainDraft = await draft(other, withPage());
    await rejects(
      updateActivity(bindings, plainDraft.id, other.id, {
        version: plainDraft.version,
        activity: withPage("https://example.com/"),
      }),
      "PAGE_NOT_ALLOWED",
    );
  });

  it("is fixed once opened: the same page is kept, another refused", async () => {
    const activity = await opened("https://example.com/a");
    const managed = await getManagedActivity(bindings, activity.id, author.id);
    const kept = await updateActivity(bindings, activity.id, author.id, {
      version: managed.version,
      activity: { ...managed.config, title: "改个标题" },
    });
    expect(kept.config.pageUrl).toBe("https://example.com/a");
    await rejects(
      updateActivity(bindings, activity.id, author.id, {
        version: kept.version,
        activity: { ...kept.config, pageUrl: "https://example.com/b" },
      }),
      "PAGE_LOCKED",
    );
    await rejects(
      updateActivity(bindings, activity.id, author.id, {
        version: kept.version,
        activity: { ...kept.config, pageUrl: "" },
      }),
      "PAGE_LOCKED",
    );
  });

  it("hides while the switch is off, and for good once the 站长 stops it", async () => {
    const activity = await opened("https://example.com/a");
    await settings({ page_enabled: 0 });
    expect(
      (await getPublicActivity(bindings, activity.id)).page,
    ).toBeUndefined();
    await settings({ page_enabled: 1 });
    expect((await getPublicActivity(bindings, activity.id)).page?.host).toBe(
      "example.com",
    );

    expect(
      (await call("POST", `/admin/activities/${activity.id}/stop-page`, author))
        .status,
    ).toBe(403);
    const stopped = await call(
      "POST",
      `/admin/activities/${activity.id}/stop-page`,
      admin,
    );
    expect(stopped).toMatchObject({ status: 200, body: { stopped: true } });
    // Again: nothing changes.
    expect(
      (await call("POST", `/admin/activities/${activity.id}/stop-page`, admin))
        .status,
    ).toBe(200);
    expect(
      (await getPublicActivity(bindings, activity.id)).page,
    ).toBeUndefined();
    expect(
      await getManagedActivity(bindings, activity.id, author.id),
    ).toMatchObject({ pageStopped: true });

    const detail = await call<{ activity: AdminActivityDetail }>(
      "GET",
      `/admin/activities/${activity.id}`,
      admin,
    );
    expect(detail.body.activity.page).toMatchObject({
      url: "https://example.com/a",
      stoppedBy: expect.any(String),
    });
    expect(detail.body.activity.page?.stoppedAt).toEqual(expect.any(Number));
    const audit = await call<{ items: AdminAuditEntry[] }>(
      "GET",
      "/admin/audit?type=page_stop",
      admin,
    );
    expect(audit.body.items[0]).toMatchObject({
      type: "page_stop",
      actorUserId: admin.id,
      activity: { id: activity.id, title: "附带网页的红包" },
    });

    // A 红包 without one has nothing to stop.
    const plain = await draft(author, withPage());
    expect(
      (await call("POST", `/admin/activities/${plain.id}/stop-page`, admin))
        .body.error?.code,
    ).toBe("PAGE_NOT_FOUND");
  });

  it("is offered to the form for PLUS while the switch is on", async () => {
    const offer = () =>
      call<{ page?: true }>("GET", "/me/balance/hongbao", author);
    expect((await offer()).body.page).toBe(true);
    await settings({ page_enabled: 0 });
    expect((await offer()).body.page).toBeUndefined();
    await settings({ page_enabled: 1 });
    const other = await actor();
    expect(
      (await call<{ page?: true }>("GET", "/me/balance/hongbao", other)).body
        .page,
    ).toBeUndefined();
  });
});
