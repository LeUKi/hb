import {
  type ActivityInput,
  type AdminActivityDetail,
  type AdminAuditEntry,
  emptyActivityInput,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { framingOf } from "../src/activities/attached-page";
import {
  createActivity,
  getManagedActivity,
  getPublicActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { listSquare } from "../src/discovery/service";
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

  it("is anyone's (since 2026-10-30), refused while the switch is off and for an address outside the rules", async () => {
    const other = await actor();
    await give(admin, other, "5.00");
    const theirs = await draft(other, withPage("https://example.com/"));
    expect(theirs.config.pageUrl).toBe("https://example.com/");
    await settings({ page_enabled: 0 });
    await rejects(
      draft(other, withPage("https://example.com/")),
      "PAGE_PAUSED",
    );
    await settings({ page_enabled: 1 });
    await expect(
      draft(author, withPage("http://example.com/")),
    ).rejects.toMatchObject({
      code: "INVALID_ACTIVITY",
      message: "只能用 https:// 开头的地址",
    });
    // Added to a draft later, by anyone, as long as the switch is on.
    const plainDraft = await draft(other, withPage());
    const added = await updateActivity(bindings, plainDraft.id, other.id, {
      version: plainDraft.version,
      activity: withPage("https://example.com/b"),
    });
    expect(added.config.pageUrl).toBe("https://example.com/b");
  });

  it("opens by itself when asked (§2.7): kept with a page only, said on the 红包 page, fixed once opened", async () => {
    const auto = await draft(author, {
      ...withPage("https://example.com/game"),
      pageAutoOpen: true,
    });
    expect(auto.config.pageAutoOpen).toBe(true);
    expect(
      (await getPublicActivity(bindings, auto.id, author.id)).page,
    ).toEqual({
      url: "https://example.com/game",
      host: "example.com",
      autoOpen: true,
    });
    // Without a page there is nothing to open.
    const none = await draft(author, { ...withPage(), pageAutoOpen: true });
    expect(none.config.pageAutoOpen).toBeUndefined();
    const opened = await openActivity(
      bindings,
      auto.id,
      author.id,
      auto.version,
    );
    const managed = await getManagedActivity(bindings, opened.id, author.id);
    await rejects(
      updateActivity(bindings, opened.id, author.id, {
        version: managed.version,
        activity: { ...managed.config, pageAutoOpen: false },
      }),
      "PAGE_LOCKED",
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

  it("is on the 红包广场's card too, as on its page: not while the switch is off, nor once stopped", async () => {
    const square = (activity: ActivityInput) =>
      draft(author, { ...activity, joinSquare: true }).then((saved) =>
        openActivity(bindings, saved.id, author.id, saved.version),
      );
    const attached = await square(withPage("https://example.com/a"));
    const plain = await square(withPage());
    const cardOf = async (id: string) =>
      (await listSquare(bindings, "all")).items.find((item) => item.id === id);
    expect((await cardOf(attached.id))?.page).toEqual({
      url: "https://example.com/a",
      host: "example.com",
    });
    expect(await cardOf(plain.id)).not.toHaveProperty("page");
    await settings({ page_enabled: 0 });
    expect(await cardOf(attached.id)).not.toHaveProperty("page");
    await settings({ page_enabled: 1 });
    await call("POST", `/admin/activities/${attached.id}/stop-page`, admin);
    expect(await cardOf(attached.id)).not.toHaveProperty("page");
  });

  it("is offered to the form for anyone while the switch is on", async () => {
    const other = await actor();
    const offer = (user: Actor) =>
      call<{ page?: true }>("GET", "/me/balance/hongbao", user);
    expect((await offer(author)).body.page).toBe(true);
    expect((await offer(other)).body.page).toBe(true);
    await settings({ page_enabled: 0 });
    expect((await offer(author)).body.page).toBeUndefined();
    expect((await offer(other)).body.page).toBeUndefined();
  });
});

describe("附带网页: may this site frame it", () => {
  afterEach(() => vi.restoreAllMocks());
  const origin = "https://hb.lafi.sh";
  const framing = (headers: Record<string, string>) =>
    framingOf(new Headers(headers), origin);

  it("reads frame-ancestors first, X-Frame-Options only without it", () => {
    expect(framing({})).toBe("yes");
    expect(framing({ "x-frame-options": "DENY" })).toBe("no");
    expect(framing({ "x-frame-options": "sameorigin" })).toBe("no");
    expect(
      framing({
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      }),
    ).toBe("no");
    expect(
      framing({ "content-security-policy": "frame-ancestors 'self'" }),
    ).toBe("no");
    for (const allowed of [
      "frame-ancestors https://hb.lafi.sh",
      "frame-ancestors hb.lafi.sh",
      "frame-ancestors https://*.lafi.sh",
      "frame-ancestors https:",
      "frame-ancestors *",
      "frame-ancestors 'self' https://hb.lafi.sh:443/any",
    ])
      expect(framing({ "content-security-policy": allowed })).toBe("yes");
    for (const refused of [
      "frame-ancestors https://example.com",
      "frame-ancestors https://hb.lafi.sh:8443",
      "frame-ancestors *.hb.lafi.sh",
    ])
      expect(framing({ "content-security-policy": refused })).toBe("no");
    // A frame-ancestors list that lets this site in: X-Frame-Options is not read.
    expect(
      framing({
        "content-security-policy": "frame-ancestors https://hb.lafi.sh",
        "x-frame-options": "DENY",
      }),
    ).toBe("yes");
    // Two policies: both must let it in.
    expect(
      framing({
        "content-security-policy":
          "frame-ancestors https://hb.lafi.sh, frame-ancestors 'none'",
      }),
    ).toBe("no");
  });

  it("asks the page for anyone signed in while the switch is on, and says unknown when it cannot", async () => {
    const answers: (Response | Error)[] = [
      new Response("<p>no</p>", {
        headers: {
          "content-security-policy":
            "default-src 'self'; frame-ancestors 'none'",
        },
      }),
      new Response("<p>yes</p>"),
      new Error("unreachable"),
    ];
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      asked.push(String(url));
      const answer = answers.shift();
      if (!answer || answer instanceof Error) throw answer ?? new Error("none");
      return answer;
    });
    const check = (user: Actor, url: string) =>
      call<{ embeddable: string }>(
        "GET",
        `/me/attached-page/check?url=${encodeURIComponent(url)}`,
        user,
      );
    expect((await check(author, "https://Chat.Example.com/")).body).toEqual({
      embeddable: "no",
    });
    expect((await check(author, "https://example.com/ok")).body).toEqual({
      embeddable: "yes",
    });
    expect((await check(author, "https://example.com/down")).body).toEqual({
      embeddable: "unknown",
    });
    expect(asked).toEqual([
      "https://chat.example.com/",
      "https://example.com/ok",
      "https://example.com/down",
    ]);
    expect((await check(author, "http://example.com/")).status).toBe(400);
    // Anyone may ask; with the switch off, nobody (and nothing is fetched).
    answers.push(new Response("<p>yes</p>"));
    const other = await actor();
    expect((await check(other, "https://example.com/other")).body).toEqual({
      embeddable: "yes",
    });
    await settings({ page_enabled: 0 });
    expect((await check(other, "https://example.com/off")).status).toBe(409);
    expect(asked).toHaveLength(4);
  });
});
