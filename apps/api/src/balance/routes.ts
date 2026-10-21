// 🐟额 for the person (docs/balance-design.md §8, §9.2).
import {
  amountToMinor,
  BALANCE_LIMITS,
  createApiKeySchema,
  createCheckoutSchema,
  createInviteSchema,
  createTopupSchema,
  createTransferSchema,
  createWithdrawalSchema,
  inviteUsernameSchema,
  ownerAdjustmentSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import {
  getOptionalSession,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import { flushPaymentOutbox } from "../payments/scheduler";
import { requireAppOrigin } from "../security/http";
import {
  apiKeyDetail,
  createApiKey,
  listApiKeys,
  revokeOwnApiKey,
} from "./api-keys";
import {
  checkCheckout,
  checkOpenCheckouts,
  checkoutMerchant,
  checkoutView,
  createCheckout,
  listReceivedCheckouts,
  ownedCheckout,
  payCheckout,
} from "./checkouts";
import {
  acceptInvite,
  createInvite,
  listMyInvites,
  previewInvitee,
  readInvite,
} from "./invites";
import {
  adjustOwnBalance,
  type BalanceRecordFilter,
  decodeRecordCursor,
  listRecords,
  readAccount,
} from "./ledger";
import { readPlatformAppRow } from "./platform-app";
import { plusOf } from "./plus";
import { readBalanceSettings, requireBalanceEntry } from "./settings";
import {
  checkOpenTopups,
  checkTopup,
  createTopup,
  ownedTopup,
  payTopup,
  topupView,
} from "./topups";
import {
  creditBlock,
  findRecipientByUsername,
  makeTransfer,
  transferAccess,
  transferDetail,
  transferViews,
} from "./transfers";
import {
  createWithdrawal,
  ownedWithdrawal,
  withdrawalDetail,
} from "./withdrawals";

const body = bodyLimit({
  maxSize: 4 * 1024,
  onError: () => {
    throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
  },
});

const recordsQuery = validator(
  "query",
  (value): { filter: BalanceRecordFilter; cursor?: string } => {
    const filter = value.filter ?? "all";
    if (
      filter !== "all" &&
      filter !== "topup" &&
      filter !== "withdrawal" &&
      filter !== "adjustment" &&
      filter !== "hongbao" &&
      filter !== "transfer"
    )
      throw new ActivityError(400, "INVALID_FILTER", "筛选无效");
    if (value.cursor !== undefined && typeof value.cursor !== "string")
      throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
    return { filter, cursor: value.cursor };
  },
);

export const balanceRoutes = new Hono<ApiContext>()
  .use("/me/balance", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .use("/me/balance/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .use("/invites/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/me/balance", recordsQuery, async (c) => {
    const session = await requireAuth(c);
    const access = await requireBalanceEntry(
      c.env,
      session.user.id,
      session.user.isAdmin,
    );
    const { filter, cursor } = c.req.valid("query");
    const [settings, account, records, pending, platform, plus, toCredit] =
      await Promise.all([
        readBalanceSettings(c.env),
        readAccount(c.env, session.user.id),
        listRecords(c.env, session.user.id, filter, cursor),
        c.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM balance_topups WHERE user_id=? AND status!='credited'",
        )
          .bind(session.user.id)
          .first<{ count: number }>(),
        readPlatformAppRow(c.env),
        plusOf(c.env, session.user.id),
        creditBlock(c.env),
      ]);
    return c.json({
      settings: {
        version: settings.version,
        topupEnabled: settings.topupEnabled,
        withdrawEnabled: settings.withdrawEnabled,
        topupFeePercent: settings.topupFeePercent,
        withdrawFeePercent: settings.withdrawFeePercent,
        withdrawMaxMinor: settings.withdrawMaxMinor,
        hongbaoEnabled: settings.hongbaoEnabled,
        transferEnabled: settings.transferEnabled,
        /** Why a 转账 cannot go to a Credit account now, if it cannot. */
        transferToCreditBlock: toCredit?.code ?? null,
        topupMinMinor: BALANCE_LIMITS.topupMinMinor,
        topupMaxMinor: BALANCE_LIMITS.topupMaxMinor,
        topupDailyHintMinor: BALANCE_LIMITS.topupDailyHintMinor,
        withdrawMinMinor: BALANCE_LIMITS.withdrawMinMinor,
      },
      account,
      /** What this person may do beyond reading and 转出. */
      access: {
        topup: access.topup,
        invite: access.invite,
        /** The 站长: 补加 and 扣回 their own instead (balance-design §15). */
        owner: platform?.author_id === session.user.id,
        /** 转账 and 开放接口密钥: 🐟额 PLUS and the 站长 (§16). */
        transfer: plus.plus,
      },
      /** 🐟额 PLUS's tag and bubble (balance-design §13). */
      plus,
      /** 转入 not arrived yet (待确认 or 未完成). */
      openTopups: pending?.count ?? 0,
      ...records,
    });
  })
  // The 发红包 form's “从哪发” (docs/balance-design.md §14): shown only
  // while 🐟额红包 are on and there is something to send.
  .get("/me/balance/hongbao", async (c) => {
    const session = await requireAuth(c);
    const [settings, account] = await Promise.all([
      readBalanceSettings(c.env),
      readAccount(c.env, session.user.id),
    ]);
    return c.json({
      /** 🐟额红包 are on at all. */
      enabled: settings.hongbaoEnabled,
      available: settings.hongbaoEnabled && account.availableMinor >= 1,
      availableMinor: account.availableMinor,
    });
  })
  .post(
    "/me/balance/topups",
    body,
    validator("json", (value) => {
      const parsed = createTopupSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(400, "INVALID_TOPUP", "请检查转入数量");
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await createTopup(
          c.env,
          session.user.id,
          c.req.valid("json"),
          requireAppOrigin(c.env),
        ),
      );
    },
  )
  // The page's own check, as it opens: a write, so not inside the read.
  .post("/me/balance/topups/check-open", async (c) => {
    const session = await requireProtectedMutation(c);
    await requireBalanceEntry(c.env, session.user.id, session.user.isAdmin);
    // 转入 not yet arrived, and 转账 to 对方的收银台 not yet paid.
    const [credited, paid] = await Promise.all([
      checkOpenTopups(c.env, session.user.id),
      checkOpenCheckouts(c.env, session.user.id, "payer"),
    ]);
    return c.json({ credited, paid });
  })
  .get("/me/balance/topups/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      topup: topupView(
        await ownedTopup(c.env, session.user.id, c.req.param("id")),
      ),
    });
  })
  .post("/me/balance/topups/:id/check", async (c) => {
    const session = await requireProtectedMutation(c);
    const row = await ownedTopup(c.env, session.user.id, c.req.param("id"));
    return c.json({
      topup: topupView(
        row.status === "credited" ? row : await checkTopup(c.env, row, "user"),
      ),
    });
  })
  .post("/me/balance/topups/:id/pay", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json(await payTopup(c.env, session.user.id, c.req.param("id")));
  })
  .post(
    "/me/balance/withdrawals",
    body,
    validator("json", (value) => {
      const parsed = createWithdrawalSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(400, "INVALID_WITHDRAWAL", "请检查转出数量");
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const { withdrawal, taskId } = await createWithdrawal(
        c.env,
        session.user.id,
        c.req.valid("json"),
        session.user.isAdmin,
      );
      // Its payment starts now; the sweep catches it if this does not.
      if (taskId)
        c.executionCtx.waitUntil(
          flushPaymentOutbox(c.env, taskId).catch(() => {
            console.error("balance_withdrawal_wake_failed", { taskId });
          }),
        );
      return c.json({ withdrawal });
    },
  )
  // The 站长's own 补加 and 扣回 (docs/balance-design.md §15).
  .post(
    "/me/balance/owner-adjustments",
    body,
    validator("json", (value) => {
      const parsed = ownerAdjustmentSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(400, "INVALID_ADJUSTMENT", "请检查数量");
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json({
        adjustment: await adjustOwnBalance(
          c.env,
          session.user.id,
          c.req.valid("json"),
        ),
      });
    },
  )
  .get("/me/balance/withdrawals/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      withdrawal: await withdrawalDetail(
        c.env,
        await ownedWithdrawal(c.env, session.user.id, c.req.param("id")),
      ),
    });
  })
  // 转账 (docs/balance-design.md §16): find who, then send.
  .get("/me/balance/recipients", async (c) => {
    const session = await requireAuth(c);
    if (!(await transferAccess(c.env, session.user.id)).allowed)
      throw new ActivityError(
        403,
        "TRANSFER_NOT_ALLOWED",
        "开通🐟额 PLUS 才能转账。",
      );
    const parsed = inviteUsernameSchema.safeParse(
      c.req.query("username") ?? "",
    );
    if (!parsed.success)
      throw new ActivityError(
        400,
        "INVALID_USERNAME",
        parsed.error.issues[0]?.message ?? "用户名无效",
      );
    const [found, platform] = await Promise.all([
      findRecipientByUsername(c.env, parsed.data),
      readPlatformAppRow(c.env),
    ]);
    // 对方的收银台: whether their LDC 商户 can take a payment now.
    const checkout =
      found && found.id !== session.user.id
        ? (await checkoutMerchant(c.env, found.id)).block
        : null;
    return c.json({
      user: found
        ? {
            userId: found.external_id,
            username: found.username,
            displayName: found.display_name,
            avatarUrl: found.avatar_url,
          }
        : null,
      self: found?.id === session.user.id,
      /** The 站长: their Credit account cannot take the platform app's. */
      owner: found !== null && found.id === platform?.author_id,
      /** Why 对方的收银台 cannot be chosen; null when it can. */
      checkoutBlock: found ? checkout : null,
    });
  })
  .post(
    "/me/balance/transfers",
    body,
    validator("json", (value) => {
      const parsed = createTransferSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(
          400,
          "INVALID_TRANSFER",
          parsed.error.issues[0]?.message ?? "请检查转账内容",
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const input = c.req.valid("json");
      const { row, taskId } = await makeTransfer(
        c.env,
        session.user.id,
        {
          toUserId: input.toUserId,
          toUsername: input.toUsername,
          destination: input.destination,
          amountMinor: amountToMinor(input.amount),
          remark: input.remark,
        },
        { kind: "page", requestId: input.requestId },
      );
      // To a Credit account: its payment starts now; the sweep catches it.
      if (taskId)
        c.executionCtx.waitUntil(
          flushPaymentOutbox(c.env, taskId).catch(() => {
            console.error("balance_transfer_wake_failed", { taskId });
          }),
        );
      const [transfer] = await transferViews(c.env, [row], session.user.id);
      return c.json({ transfer: transfer ?? null });
    },
  )
  // 转账 through 对方的收银台 (§16): ordered here, paid at Credit 站.
  .post(
    "/me/balance/checkouts",
    body,
    validator("json", (value) => {
      const parsed = createCheckoutSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(
          400,
          "INVALID_CHECKOUT",
          parsed.error.issues[0]?.message ?? "请检查付款内容",
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await createCheckout(
          c.env,
          { id: session.user.id, username: session.user.username },
          c.req.valid("json"),
          requireAppOrigin(c.env),
        ),
      );
    },
  )
  // 收到的付款, on the recipient's LDC 商户 page.
  .get("/me/balance/checkouts/received", async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await listReceivedCheckouts(
        c.env,
        session.user.id,
        decodeRecordCursor(c.req.query("cursor")),
      ),
    );
  })
  .post("/me/balance/checkouts/received/check-open", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      paid: await checkOpenCheckouts(c.env, session.user.id, "recipient"),
    });
  })
  .get("/me/balance/checkouts/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      checkout: checkoutView(
        await ownedCheckout(c.env, session.user.id, c.req.param("id")),
        session.user.id,
      ),
    });
  })
  .post("/me/balance/checkouts/:id/check", async (c) => {
    const session = await requireProtectedMutation(c);
    const row = await ownedCheckout(c.env, session.user.id, c.req.param("id"));
    if (row.status !== "paid") await checkCheckout(c.env, row, "user");
    return c.json({
      checkout: checkoutView(
        await ownedCheckout(c.env, session.user.id, row.id),
        session.user.id,
      ),
    });
  })
  .post("/me/balance/checkouts/:id/pay", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json(await payCheckout(c.env, session.user.id, c.req.param("id")));
  })
  .get("/me/balance/transfers/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      transfer: await transferDetail(c.env, session.user.id, c.req.param("id")),
    });
  })
  // 开放接口密钥: made, listed, opened and stopped here only.
  .get("/me/balance/api-keys", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      items: await listApiKeys(c.env, session.user.id),
      max: BALANCE_LIMITS.apiKeysMax,
    });
  })
  .post(
    "/me/balance/api-keys",
    body,
    validator("json", (value) => {
      const parsed = createApiKeySchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(
          400,
          "INVALID_API_KEY_INPUT",
          parsed.error.issues[0]?.message ?? "请检查名称和上限",
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await createApiKey(c.env, session.user.id, c.req.valid("json")),
      );
    },
  )
  .get(
    "/me/balance/api-keys/:id",
    validator("query", (value): { cursor?: string } => {
      if (value.cursor !== undefined && typeof value.cursor !== "string")
        throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
      return { cursor: value.cursor };
    }),
    async (c) => {
      const session = await requireAuth(c);
      const { cursor } = c.req.valid("query");
      return c.json(
        await apiKeyDetail(c.env, session.user.id, c.req.param("id"), cursor),
      );
    },
  )
  .post("/me/balance/api-keys/:id/revoke", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      key: await revokeOwnApiKey(c.env, session.user.id, c.req.param("id")),
    });
  })
  // 邀请 (docs/balance-design.md §13): the dialog on 🐟额, then the link's page.
  .get("/me/balance/invites", async (c) => {
    const session = await requireAuth(c);
    return c.json({ items: await listMyInvites(c.env, session.user.id) });
  })
  .get("/me/balance/invites/preview", async (c) => {
    const session = await requireAuth(c);
    const parsed = inviteUsernameSchema.safeParse(
      c.req.query("username") ?? "",
    );
    if (!parsed.success)
      throw new ActivityError(
        400,
        "INVALID_USERNAME",
        parsed.error.issues[0]?.message ?? "用户名无效",
      );
    return c.json(await previewInvitee(c.env, session.user, parsed.data));
  })
  .post(
    "/me/balance/invites",
    body,
    validator("json", (value) => {
      const parsed = createInviteSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(
          400,
          "INVALID_USERNAME",
          parsed.error.issues[0]?.message ?? "用户名无效",
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await createInvite(
          c.env,
          session.user,
          c.req.valid("json").username,
          requireAppOrigin(c.env),
        ),
      );
    },
  )
  // Open to anyone with the link: who sent it, and what this viewer can do.
  .get("/invites/:token", async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await readInvite(
        c.env,
        c.req.param("token"),
        session ? session.user : null,
      ),
    );
  })
  .post("/invites/:token/accept", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json(
      await acceptInvite(c.env, c.req.param("token"), session.user),
    );
  });
