// 私信通知 (docs/notification-design.md): how a notice reads, the SMTP
// talk with the 社区's mail server, the outbox with its queue and cron,
// someone's switches, and 红包广场's 下一个红包开放时提醒我.
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { emailAssociatedData } from "../src/auth/oauth";
import type { ApiBindings } from "../src/env";
import {
  handleNoticeBatch,
  notify,
  paced,
  sweepNotices,
} from "../src/notices/outbox";
import {
  type Mail,
  type MailOutcome,
  messageOf,
  type SmtpAccount,
  type SmtpConnection,
  sendMails,
} from "../src/notices/smtp";
import { bodyOf, LINE_COLUMNS, wrapParagraph } from "../src/notices/text";
import { encryptString, sha256Hex } from "../src/security/crypto";
import { ldcInput, simulatedLdcInput } from "./activity-fixtures";

const origin = "https://hb.example.com";
let admins: string[] = [];
const bindings = (more: Partial<ApiBindings> = {}) =>
  ({
    ...env,
    APP_ORIGIN: origin,
    ADMIN_LINUX_DO_IDS: admins.join(","),
    ...more,
  }) as ApiBindings;

afterEach(() => {
  admins = [];
});

type Person = {
  id: string;
  externalId: string;
  username: string;
  cookie: string;
  csrf: string;
};

let counter = 0;
async function person(
  options: { email?: string | null; trustLevel?: number } = {},
): Promise<Person> {
  counter += 1;
  const id = crypto.randomUUID();
  const externalId = String(770_000 + counter * 13);
  const username = `notice${counter}`;
  const email =
    options.email === undefined
      ? `x${counter}abc@privaterelay.linux.do`
      : options.email;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id,provider,external_id,username,display_name,email_ciphertext,active,trust_level,profile_seen_at,created_at,updated_at)
     VALUES (?,'linux_do',?,?,?,?,1,?,?,?,?)`,
  )
    .bind(
      id,
      externalId,
      username,
      username,
      email
        ? await encryptString(
            email,
            env,
            emailAssociatedData("linux_do", externalId),
          )
        : null,
      options.trustLevel ?? 2,
      now,
      now,
      now,
    )
    .run();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?,?)`,
  )
    .bind(
      await sha256Hex(`hb.session-token.v1:${token}`),
      id,
      csrf,
      now,
      now + 600_000,
      now,
    )
    .run();
  return { id, externalId, username, cookie: `hb_session=${token}`, csrf };
}

async function call(
  method: string,
  path: string,
  who?: Person,
  body?: unknown,
) {
  const ctx = createExecutionContext();
  const response = await app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        ...(who ? { Cookie: who.cookie, "X-CSRF-Token": who.csrf } : {}),
        ...(method === "GET" ? {} : { Origin: origin }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, json: (await response.json()) as never };
}

const columns = (line: string) =>
  [...line].reduce(
    (sum, character) => sum + (/[\x20-\x7e]/.test(character) ? 1 : 2),
    0,
  );

describe("how a notice reads", () => {
  it("breaks lines at 20 汉字, keeps words and links whole, and never starts a line with a closing mark", () => {
    const lines = wrapParagraph(
      "《周五摸鱼》有 3 个人领了，还没付出去：你的 Credit 余额不够。补上以后会自动接着付。这个红包只提醒这一次。",
    );
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(columns(line)).toBeLessThanOrEqual(LINE_COLUMNS + 2);
      expect(line).not.toMatch(/^[，。：、]/u);
    }
    expect(lines.join("")).toContain("Credit");
    const body = bodyOf(
      ["开奖了。"],
      {
        label: "开奖结果",
        url: "https://hb.lafi.sh/🧧/🐱🐶🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷",
      },
      "https://hb.lafi.sh/notifications",
    );
    expect(body).toBe(
      "开奖了。\n\n开奖结果：\nhttps://hb.lafi.sh/🧧/🐱🐶🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷\n\n不想收这类通知，在这里关：\nhttps://hb.lafi.sh/notifications\n",
    );
  });
});

/** A mail server that answers as told and keeps what it was sent. */
function fakeServer(
  answer: (command: string) => string | undefined = () => undefined,
): SmtpConnection & { commands: string[]; data: string[] } {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let push: (text: string) => void = () => {};
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => controller.enqueue(encoder.encode(text));
      push("220 mail.test ESMTP\r\n");
    },
  });
  const commands: string[] = [];
  const data: string[] = [];
  let buffer = "";
  let inData = false;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += decoder.decode(chunk);
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          push("250 queued\r\n");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(command);
        const told = answer(command);
        if (told) {
          push(`${told}\r\n`);
          continue;
        }
        if (command.startsWith("EHLO"))
          push("250-mail.test\r\n250 AUTH PLAIN\r\n");
        else if (command.startsWith("AUTH")) push("235 ok\r\n");
        else if (command === "DATA") {
          inData = true;
          push("354 go\r\n");
        } else if (command === "QUIT") push("221 bye\r\n");
        else push("250 ok\r\n");
      }
    },
  });
  return { readable, writable, close: async () => {}, commands, data };
}

const account: SmtpAccount = {
  host: "mail.test",
  port: 465,
  user: "site@linux.do",
  password: "token",
  domain: "hb.example.com",
  fromName: "红包站",
};
const mail = (id: string, to: string): Mail => ({
  id,
  to,
  subject: "红包站：你在《周五摸鱼》中了 5.00 LDC",
  text: "《周五摸鱼》开奖了。\n\n开奖结果：\nhttps://hb.lafi.sh/x\n",
});

describe("SMTP to the 社区's mail server", () => {
  it("logs in once, sends each, and tells a refused one from the rest", async () => {
    const server = fakeServer((command) =>
      command === "RCPT TO:<bad@privaterelay.linux.do>"
        ? "550 no such user"
        : undefined,
    );
    const outcomes = await sendMails(
      account,
      [
        mail("a", "a@privaterelay.linux.do"),
        mail("b", "bad@privaterelay.linux.do"),
        mail("c", "c@privaterelay.linux.do"),
      ],
      async () => server,
    );
    expect(outcomes).toEqual([
      { id: "a", ok: true, at: expect.any(Number) },
      {
        id: "b",
        ok: false,
        permanent: true,
        reason: expect.stringContaining("550"),
      },
      { id: "c", ok: true, at: expect.any(Number) },
    ]);
    expect(server.commands.filter((c) => c.startsWith("AUTH"))).toHaveLength(1);
    expect(atob(server.commands[1]?.slice("AUTH PLAIN ".length) ?? "")).toBe(
      "\0site@linux.do\0token",
    );
    expect(server.data).toHaveLength(2);
  });

  it("keeps any two mails apart, and two to one person further apart", async () => {
    const server = fakeServer();
    const started = Date.now();
    const outcomes = await sendMails(
      account,
      [
        mail("a", "a@privaterelay.linux.do"),
        mail("b", "b@privaterelay.linux.do"),
        mail("c", "a@privaterelay.linux.do"),
      ],
      async () => server,
      { anyGapMs: 30, samePersonGapMs: 150 },
    );
    const at = (id: string) => {
      const outcome = outcomes.find((each) => each.id === id);
      return outcome?.ok ? outcome.at : Number.NaN;
    };
    expect(at("b") - at("a")).toBeGreaterThanOrEqual(29);
    expect(at("b") - at("a")).toBeLessThan(140);
    expect(at("c") - at("a")).toBeGreaterThanOrEqual(149);
    expect(Date.now() - started).toBeGreaterThanOrEqual(149);
  });

  it("keeps the gap from the last mail before the session too", async () => {
    const lastAny = Date.now();
    const [outcome] = await sendMails(
      account,
      [mail("a", "a@privaterelay.linux.do")],
      async () => fakeServer(),
      { anyGapMs: 80, samePersonGapMs: 0, lastAny },
    );
    const at = outcome?.ok ? outcome.at : Number.NaN;
    expect(at - lastAny).toBeGreaterThanOrEqual(79);
  });

  it("starts no mail past its stop time, says when the rest are due, and logs in only for one that goes", async () => {
    const server = fakeServer();
    let opened = 0;
    const open = async () => {
      opened += 1;
      return server;
    };
    const outcomes = await sendMails(
      account,
      [
        mail("a", "a@privaterelay.linux.do"),
        mail("b", "b@privaterelay.linux.do"),
      ],
      open,
      { anyGapMs: 60_000, samePersonGapMs: 0 },
      { stopAt: Date.now() + 1_000 },
    );
    const sentAt = outcomes[0]?.ok ? outcomes[0].at : Number.NaN;
    expect(outcomes).toEqual([
      { id: "a", ok: true, at: sentAt },
      { id: "b", ok: false, due: sentAt + 60_000 },
    ]);
    expect(server.data).toHaveLength(1);
    expect(server.commands.at(-1)).toBe("QUIT");
    expect(opened).toBe(1);

    // Nothing due before the stop: no session at all.
    const before = Date.now();
    expect(
      await sendMails(
        account,
        [mail("c", "a@privaterelay.linux.do")],
        open,
        {
          anyGapMs: 0,
          samePersonGapMs: 60_000,
          lastSent: new Map([["a@privaterelay.linux.do", before]]),
        },
        { stopAt: Date.now() + 1_000 },
      ),
    ).toEqual([{ id: "c", ok: false, due: before + 60_000 }]);
    expect(opened).toBe(1);
  });

  it("tells of each mail before the next one starts, and stops when told", async () => {
    const server = fakeServer();
    const told: [string, number][] = [];
    const outcomes = await sendMails(
      account,
      [
        mail("a", "a@privaterelay.linux.do"),
        mail("b", "b@privaterelay.linux.do"),
        mail("c", "c@privaterelay.linux.do"),
      ],
      async () => server,
      { anyGapMs: 0, samePersonGapMs: 0 },
      {
        onSent: async ({ id }) => {
          told.push([id, server.data.length]);
          return id !== "b";
        },
      },
    );
    expect(told).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(outcomes).toEqual([
      { id: "a", ok: true, at: expect.any(Number) },
      { id: "b", ok: true, at: expect.any(Number) },
      { id: "c", ok: false, due: expect.any(Number) },
    ]);
    expect(server.data).toHaveLength(2);
  });

  it("leaves everything for later when the session breaks off", async () => {
    const server = fakeServer((command) =>
      command.startsWith("AUTH") ? "454 try later" : undefined,
    );
    const outcomes = await sendMails(
      account,
      [mail("a", "a@privaterelay.linux.do")],
      async () => server,
    );
    expect(outcomes).toEqual([
      { id: "a", ok: false, permanent: false, reason: expect.any(String) },
    ]);
  });

  it("writes plain text only: an encoded subject and a base64 body", () => {
    const message = messageOf(
      account,
      mail("m1", "a@privaterelay.linux.do"),
      new Date(0),
    );
    expect(message).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(message).not.toContain("text/html");
    expect(message).toContain("Message-ID: <m1@hb.example.com>");
    const subject = message.match(/^Subject: ((?:.|\r\n )+)$/m)?.[1] ?? "";
    const decoded = [...subject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
      .map((part) =>
        new TextDecoder().decode(
          Uint8Array.from(atob(part[1] ?? ""), (c) => c.charCodeAt(0)),
        ),
      )
      .join("");
    expect(decoded).toBe("红包站：你在《周五摸鱼》中了 5.00 LDC");
    for (const line of message.split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(78);
    expect(message.endsWith("\r\n.\r\n")).toBe(true);
  });

  it("adds an HTML part beside the text when given one, an empty one too", () => {
    const message = messageOf(
      account,
      { ...mail("m2", "a@privaterelay.linux.do"), html: "" },
      new Date(0),
    );
    expect(message).toContain(
      'Content-Type: multipart/alternative; boundary="hb_m2"',
    );
    const parts = message.split("--hb_m2");
    expect(parts).toHaveLength(4);
    expect(parts[1]).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(parts[2]).toContain("Content-Type: text/html; charset=UTF-8");
    expect(parts[3]?.startsWith("--\r\n.\r\n")).toBe(true);
  });
});

function batchOf(ids: string[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const delays = new Map<string, number | undefined>();
  return {
    acked,
    retried,
    delays,
    batch: {
      queue: "hb-local-notices",
      messages: ids.map((id) => ({
        id,
        body: { type: "notice.send", id },
        timestamp: new Date(),
        attempts: 1,
        ack: () => acked.push(id),
        retry: (options?: { delaySeconds?: number }) => {
          retried.push(id);
          delays.set(id, options?.delaySeconds);
        },
      })),
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<unknown>,
  };
}

async function noticesOf(userId: string) {
  return (
    await env.DB.prepare(
      "SELECT id,kind,status,reason,attempts,subject FROM notifications WHERE user_id=? ORDER BY created_at",
    )
      .bind(userId)
      .all<{
        id: string;
        kind: string;
        status: string;
        reason: string | null;
        attempts: number;
        subject: string;
      }>()
  ).results;
}

const said = { subject: "红包站：测试", body: "测试\n" };

describe("the outbox", () => {
  it("sends everyone's first mail before anyone's second", () => {
    expect(
      paced([
        { userId: "a", id: 1 },
        { userId: "a", id: 2 },
        { userId: "b", id: 3 },
        { userId: "a", id: 4 },
        { userId: "c", id: 5 },
      ]).map((item) => item.id),
    ).toEqual([1, 3, 5, 2, 4]);
  });

  it("writes one row an event, and none for the 站长", async () => {
    const someone = await person();
    const owner = await person();
    admins = [owner.externalId];
    const noQueue = bindings({ NOTICE_QUEUE: undefined });
    await notify(noQueue, [
      {
        userId: someone.id,
        kind: "tip_received",
        key: "tip_received:t1",
        ...said,
      },
      {
        userId: someone.id,
        kind: "tip_received",
        key: "tip_received:t1",
        ...said,
      },
      {
        userId: owner.id,
        kind: "tip_received",
        key: "tip_received:t2",
        ...said,
      },
    ]);
    expect(await noticesOf(someone.id)).toEqual([
      expect.objectContaining({ kind: "tip_received", status: "queued" }),
    ]);
    expect(await noticesOf(owner.id)).toEqual([]);
  });

  it("sends to 隐私邮箱 only, skips the turned off and the unreachable, and tries again what failed for now", async () => {
    const reachable = await person();
    const turnedOff = await person();
    const noEmail = await person({ email: null });
    const realAddress = await person({ email: "me@gmail.com" });
    const later = await person();
    await env.DB.prepare(
      "INSERT INTO notification_settings (user_id,category,enabled,updated_at) VALUES (?,'tip_received',0,?)",
    )
      .bind(turnedOff.id, Date.now())
      .run();
    const noQueue = bindings({
      NOTICE_QUEUE: undefined,
      NOTICE_SMTP_USER: "site@linux.do",
      NOTICE_SMTP_TOKEN: "token",
    });
    await notify(
      noQueue,
      [reachable, turnedOff, noEmail, realAddress, later].map((who, index) => ({
        userId: who.id,
        kind: "tip_received" as const,
        key: `tip_received:outbox-${counter}-${index}`,
        ...said,
      })),
    );
    const ids = (
      await Promise.all(
        [reachable, turnedOff, noEmail, realAddress, later].map((who) =>
          noticesOf(who.id),
        ),
      )
    ).map((rows) => rows[0]?.id ?? "");
    const sent: Mail[] = [];
    const { batch, acked, retried } = batchOf(ids);
    await handleNoticeBatch(batch, noQueue, async (_account, mails) => {
      sent.push(...mails);
      return mails.map((each) =>
        each.id === ids[4]
          ? {
              id: each.id,
              ok: false as const,
              permanent: false,
              reason: "smtp 421",
            }
          : { id: each.id, ok: true as const, at: Date.now() },
      );
    });
    expect(sent.map((each) => each.id).sort()).toEqual([ids[0], ids[4]].sort());
    expect(sent.find((each) => each.id === ids[0])?.to).toMatch(
      /@privaterelay\.linux\.do$/,
    );
    const status = async (who: Person) => (await noticesOf(who.id))[0];
    expect(await status(reachable)).toMatchObject({ status: "sent" });
    expect(await status(turnedOff)).toMatchObject({
      status: "skipped",
      reason: "off",
    });
    expect(await status(noEmail)).toMatchObject({
      status: "skipped",
      reason: "no_email",
    });
    expect(await status(realAddress)).toMatchObject({
      status: "skipped",
      reason: "not_relay",
    });
    expect(await status(later)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    expect(retried).toEqual([ids[4]]);
    expect(acked.sort()).toEqual(ids.slice(0, 4).sort());
  });

  const sending = (more: Partial<ApiBindings> = {}) =>
    bindings({
      NOTICE_QUEUE: undefined,
      NOTICE_SMTP_USER: "site@linux.do",
      NOTICE_SMTP_TOKEN: "token",
      ...more,
    });

  /** One queued notice each for these people. */
  async function queuedFor(people: Person[]) {
    await notify(
      sending(),
      people.map((who, index) => ({
        userId: who.id,
        kind: "tip_received" as const,
        key: `tip_received:queued-${counter}-${index}`,
        ...said,
      })),
    );
    return (await Promise.all(people.map((who) => noticesOf(who.id)))).map(
      (rows) => rows[0]?.id ?? "",
    );
  }

  const noticeById = (id: string) =>
    env.DB.prepare(
      "SELECT status,reason,attempts,sent_at FROM notifications WHERE id=?",
    )
      .bind(id)
      .first();

  it("writes each mail down the moment it has gone, so a run stopped after it never sends it again", async () => {
    const ids = await queuedFor([await person(), await person()]);
    let sentId = "";
    let sentAt = 0;
    await expect(
      handleNoticeBatch(
        batchOf(ids).batch,
        sending(),
        async (_account, mails, _open, _pace, limits) => {
          sentId = mails[0]?.id ?? "";
          sentAt = Date.now();
          expect(await limits?.onSent?.({ id: sentId, at: sentAt })).toBe(true);
          // The queue stops the consumer here (its 15 minutes are up).
          throw new Error("stopped");
        },
      ),
    ).rejects.toThrow("stopped");
    const otherId = ids.find((id) => id !== sentId) ?? "";
    expect(await noticeById(sentId)).toMatchObject({
      status: "sent",
      attempts: 1,
      sent_at: sentAt,
    });
    expect(await noticeById(otherId)).toMatchObject({
      status: "queued",
      attempts: 0,
    });

    // The batch comes again: only the other one goes, a gap after the first.
    const again = batchOf(ids);
    const sent: string[] = [];
    let lastAny: number | undefined;
    await handleNoticeBatch(
      again.batch,
      sending(),
      async (_account, mails, _open, pace) => {
        sent.push(...mails.map((each) => each.id));
        lastAny = pace?.lastAny;
        return mails.map((each) => ({
          id: each.id,
          ok: true as const,
          at: Date.now(),
        }));
      },
    );
    expect(sent).toEqual([otherId]);
    expect(lastAny).toBe(sentAt);
    expect(again.acked.sort()).toEqual([...ids].sort());
    expect(await noticeById(otherId)).toMatchObject({ status: "sent" });
  });

  it("never sends again what went out when the write at the end fails", async () => {
    // The one without a 隐私邮箱 leaves a skip for the write at the end.
    const ids = await queuedFor([
      await person(),
      await person(),
      await person({ email: null }),
    ]);
    const first = batchOf(ids);
    await handleNoticeBatch(
      first.batch,
      sending({
        DB: {
          prepare: (query: string) => env.DB.prepare(query),
          batch: async () => {
            throw new Error("D1 is down");
          },
        } as unknown as D1Database,
      }),
      async (_account, mails, _open, _pace, limits) => {
        const outcomes: MailOutcome[] = [];
        for (const each of mails) {
          const at = Date.now();
          await limits?.onSent?.({ id: each.id, at });
          outcomes.push({ id: each.id, ok: true, at });
        }
        return outcomes;
      },
    );
    expect(first.retried.sort()).toEqual([...ids].sort());
    for (const id of ids.slice(0, 2))
      expect(await noticeById(id)).toMatchObject({
        status: "sent",
        attempts: 1,
      });

    const again = batchOf(ids);
    let sends = 0;
    await handleNoticeBatch(again.batch, sending(), async (_account, mails) => {
      sends += 1;
      return mails.map((each) => ({
        id: each.id,
        ok: true as const,
        at: Date.now(),
      }));
    });
    expect(sends).toBe(0);
    expect(again.acked.sort()).toEqual([...ids].sort());
    expect(await noticeById(ids[2] ?? "")).toMatchObject({
      status: "skipped",
      reason: "no_email",
    });
  });

  it("leaves what is not due within the run for a later one, back on the queue when due, with no try counted", async () => {
    const ids = await queuedFor([await person()]);
    const id = ids[0] ?? "";
    const { batch, acked, retried, delays } = batchOf(ids);
    let stopAt = 0;
    await handleNoticeBatch(
      batch,
      sending(),
      async (_account, mails, _open, _pace, limits) => {
        stopAt = limits?.stopAt ?? 0;
        return mails.map((each) => ({
          id: each.id,
          ok: false as const,
          due: Date.now() + 30_000,
        }));
      },
    );
    // About 10 minutes a run: the queue stops a consumer at 15.
    expect(stopAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(stopAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(await noticeById(id)).toMatchObject({
      status: "queued",
      attempts: 0,
      reason: null,
    });
    expect(acked).toEqual([]);
    expect(retried).toEqual([id]);
    expect(delays.get(id)).toBeGreaterThanOrEqual(29);
    expect(delays.get(id)).toBeLessThanOrEqual(30);
  });
});

describe("the outbox's cron", () => {
  it("clears bodies once past 30 days, looking back no further than two days past that", async () => {
    const someone = await person();
    const now = Date.now();
    const day = 86_400_000;
    const ages = { kept: 29 * day, due: 31 * day, older: 33 * day };
    for (const [name, age] of Object.entries(ages))
      await env.DB.prepare(
        `INSERT INTO notifications (id,user_id,kind,dedupe_key,subject,body,status,attempts,created_at,updated_at,sent_at)
         VALUES (?,?,'tip_received',?,?,?,'sent',1,?,?,?)`,
      )
        .bind(
          `nt_${crypto.randomUUID()}`,
          someone.id,
          `sweep:${counter}:${name}`,
          said.subject,
          said.body,
          now - age,
          now - age,
          now - age,
        )
        .run();
    await sweepNotices(bindings({ NOTICE_QUEUE: undefined }), now);
    const bodies = Object.fromEntries(
      (
        await env.DB.prepare(
          "SELECT dedupe_key, body FROM notifications WHERE user_id=?",
        )
          .bind(someone.id)
          .all<{ dedupe_key: string; body: string }>()
      ).results.map((row) => [row.dedupe_key.split(":").at(-1), row.body]),
    );
    // Rows further back were cleared by the runs of their day; reading them
    // all again each time is what the bound saves.
    expect(bodies).toEqual({ kept: said.body, due: "", older: said.body });
  });
});

describe("私信通知's pace in 网站管理", () => {
  it("is the 站长's to read and change, one version at a time", async () => {
    const owner = await person();
    admins = [owner.externalId];
    const someone = await person();
    expect(
      (await call("GET", "/admin/notifications/pace", someone)).status,
    ).toBe(403);
    const read = await call("GET", "/admin/notifications/pace", owner);
    expect(read.json).toMatchObject({
      pace: { anyGapSeconds: 20, samePersonGapSeconds: 20 },
    });
    const version = (read.json as { pace: { version: number } }).pace.version;
    const saved = await call("PATCH", "/admin/notifications/pace", owner, {
      expectedVersion: version,
      anyGapSeconds: 5,
      samePersonGapSeconds: 30,
    });
    expect(saved.json).toMatchObject({
      pace: {
        version: version + 1,
        anyGapSeconds: 5,
        samePersonGapSeconds: 30,
      },
    });
    expect(
      (
        await call("PATCH", "/admin/notifications/pace", owner, {
          expectedVersion: version,
          anyGapSeconds: 1,
          samePersonGapSeconds: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("PATCH", "/admin/notifications/pace", owner, {
          expectedVersion: version + 1,
          anyGapSeconds: -1,
          samePersonGapSeconds: 1,
        })
      ).status,
    ).toBe(400);
  });
});

describe("私信通知 page", () => {
  it("shows the switches, turns one off, and says why the 站长 gets none", async () => {
    const someone = await person();
    const first = await call("GET", "/me/notifications", someone);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      availability: "ok",
      switches: { tip_received: true, draw_won: true },
      groups: { judge: false, points: false },
      recent: [],
    });
    const off = await call("PUT", "/me/notifications/tip_received", someone, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ switches: { tip_received: false } });
    expect(
      (
        await call("PUT", "/me/notifications/nothing", someone, {
          enabled: false,
        })
      ).status,
    ).toBe(400);

    const nobody = await person({ email: null });
    expect((await call("GET", "/me/notifications", nobody)).json).toMatchObject(
      {
        availability: "no_email",
      },
    );
    const owner = await person();
    admins = [owner.externalId];
    expect((await call("GET", "/me/notifications", owner)).json).toMatchObject({
      availability: "owner",
    });
  });
});

describe("红包广场's 下一个红包开放时提醒我", () => {
  const merchants = new Map<string, string>();
  async function squareHongbao(authorId: string, scope?: { levels: number[] }) {
    const local = bindings({ NOTICE_QUEUE: undefined });
    const input = merchants.has(authorId)
      ? ldcInput({ merchantId: merchants.get(authorId) })
      : await simulatedLdcInput(local, authorId);
    merchants.set(authorId, input.merchantId);
    const draft = await createActivity(local, authorId, {
      requestId: crypto.randomUUID(),
      activity: {
        ...input,
        title: "周五摸鱼",
        joinSquare: true,
        ...(scope ? { scope } : {}),
      },
    });
    return openActivity(local, draft.id, authorId, draft.version);
  }

  it("tells once, then needs another press; a 红包 outside one's range does not use it up", async () => {
    const author = await person();
    const watcher = await person();
    const newcomer = await person({ trustLevel: 0 });
    const unreachable = await person({ email: null });
    await env.DB.prepare("DELETE FROM square_watchers").run();
    expect((await call("GET", "/square/watch", watcher)).json).toEqual({
      squareWatch: { watching: false },
      waiting: 0,
    });
    expect((await call("GET", "/square/watch", unreachable)).json).toEqual({
      squareWatch: null,
      waiting: 0,
    });
    for (const [index, who] of [watcher, newcomer].entries())
      expect(
        (await call("PUT", "/square/watch", who, { watching: true })).json,
      ).toEqual({ squareWatch: { watching: true }, waiting: index + 1 });
    // Anyone sees how many wait, signed in or not.
    expect((await call("GET", "/square/watch")).json).toEqual({
      squareWatch: null,
      waiting: 2,
    });
    expect(
      (await call("PUT", "/square/watch", unreachable, { watching: true }))
        .status,
    ).toBe(409);

    // Lv2 and up only: the newcomer (Lv0) waits on.
    const first = await squareHongbao(author.id, { levels: [2, 3, 4] });
    expect(await noticesOf(watcher.id)).toEqual([
      expect.objectContaining({
        kind: "square_watch",
        subject: "红包站：红包广场有新红包：《周五摸鱼》",
      }),
    ]);
    expect(await noticesOf(newcomer.id)).toEqual([]);
    expect((await call("GET", "/square/watch", watcher)).json).toEqual({
      squareWatch: { watching: false },
      waiting: 1,
    });
    expect((await call("GET", "/square/watch", newcomer)).json).toEqual({
      squareWatch: { watching: true },
      waiting: 1,
    });

    // The next one: only the newcomer still waited.
    await squareHongbao(author.id);
    expect(await noticesOf(watcher.id)).toHaveLength(1);
    expect(await noticesOf(newcomer.id)).toHaveLength(1);
    expect(first.id).toBeTruthy();
  });
});

describe("开放时提醒我 on a timed 红包", () => {
  it("is for others than its sender, tells each once when it opens, then lets them go", async () => {
    const author = await person();
    const viewer = await person();
    const local = bindings({ NOTICE_QUEUE: undefined });
    const draft = await createActivity(local, author.id, {
      requestId: crypto.randomUUID(),
      activity: {
        ...(await simulatedLdcInput(local, author.id)),
        title: "定时摸鱼",
      },
    });
    // Not timed: nobody can ask yet.
    expect(
      (await call("GET", `/activities/${draft.id}/opening-watch`, viewer)).json,
    ).toEqual({ openingWatch: null });
    await env.DB.prepare("UPDATE activities SET scheduled_open_at=? WHERE id=?")
      .bind(Date.now() + 3_600_000, draft.id)
      .run();
    expect(
      (await call("GET", `/activities/${draft.id}/opening-watch`, author)).json,
    ).toEqual({ openingWatch: null });
    expect(
      (await call("GET", `/activities/${draft.id}/opening-watch`, viewer)).json,
    ).toEqual({ openingWatch: { watching: false } });
    expect(
      (
        await call("PUT", `/activities/${draft.id}/opening-watch`, viewer, {
          watching: true,
        })
      ).json,
    ).toEqual({ openingWatch: { watching: true } });

    const current = await env.DB.prepare(
      "SELECT version FROM activities WHERE id=?",
    )
      .bind(draft.id)
      .first<{ version: number }>();
    await openActivity(local, draft.id, author.id, current?.version ?? 0);
    expect(await noticesOf(viewer.id)).toEqual([
      expect.objectContaining({
        kind: "opening_watch",
        subject: "红包站：你等的《定时摸鱼》开放了",
      }),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM opening_watchers WHERE activity_id=?",
      )
        .bind(draft.id)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      (
        await call("PUT", `/activities/${draft.id}/opening-watch`, viewer, {
          watching: true,
        })
      ).status,
    ).toBe(409);
  });
});
