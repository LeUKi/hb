// 打赏 on 红包站 (docs/tip-design.md §7): 我的打赏 for a card's owner, and
// the public card (its ☕ page and outside embeds) for anyone.
import {
  createTipSchema,
  TIP_LIMITS,
  tipCardInputSchema,
  tipMethodSchema,
  tipRangeSchema,
  updateTipCardSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import type { ZodType } from "zod";
import { ActivityError } from "../activities/errors";
import { verifyCapToken } from "../activities/human-check";
import {
  getOptionalSession,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import { requireAppOrigin } from "../security/http";
import {
  createCard,
  listOwnCards,
  publicCard,
  recentOf,
  requireCard,
  startCard,
  stopCard,
  tipError,
  updateCard,
} from "./cards";
import {
  checkTipOnCard,
  createTip,
  listTips,
  receiptOf,
  setMessageHidden,
  viewerOf,
} from "./service";

const body = bodyLimit({
  maxSize: 16 * 1024,
  onError: () => {
    throw new ActivityError(413, "REQUEST_TOO_LARGE", "请求太大了");
  },
});

function json<T>(schema: ZodType<T>, code: string) {
  return validator("json", (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ActivityError(
        400,
        code,
        parsed.error.issues[0]?.message ?? "请检查填写的内容",
      );
    return parsed.data;
  });
}

export const tipRoutes = new Hono<ApiContext>()
  // 我的打赏: one's cards, how many one may keep on.
  .get("/me/tips", async (c) => {
    const session = await requireAuth(c);
    return c.json(await listOwnCards(c.env, session.user.id));
  })
  .post(
    "/me/tips/cards",
    body,
    json(tipCardInputSchema, "INVALID_TIP_CARD"),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json({
        card: await createCard(c.env, session.user.id, c.req.valid("json")),
      });
    },
  )
  .patch(
    "/me/tips/cards/:code",
    body,
    json(updateTipCardSchema, "INVALID_TIP_CARD"),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json({
        card: await updateCard(
          c.env,
          session.user.id,
          c.req.param("code"),
          c.req.valid("json"),
        ),
      });
    },
  )
  .post("/me/tips/cards/:code/stop", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      card: await stopCard(c.env, session.user.id, c.req.param("code")),
    });
  })
  .post("/me/tips/cards/:code/start", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      card: await startCard(c.env, session.user.id, c.req.param("code")),
    });
  })
  // 收到的 / 我打赏的, filtered by card, method and time.
  .get("/me/tips/:side{in|out}", async (c) => {
    const session = await requireAuth(c);
    const method = tipMethodSchema.safeParse(c.req.query("method"));
    const range = tipRangeSchema.safeParse(c.req.query("range") ?? "week");
    return c.json(
      await listTips(
        c.env,
        session.user.id,
        c.req.param("side") === "in" ? "in" : "out",
        {
          card: c.req.query("card") || undefined,
          method: method.success ? method.data : undefined,
          range: range.success ? range.data : "week",
        },
        c.req.query("cursor"),
      ),
    );
  })
  .post(
    "/me/tips/:id/message",
    body,
    validator("json", (value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { hidden?: unknown }).hidden !== "boolean"
      )
        throw new ActivityError(400, "INVALID_REQUEST", "请检查请求内容");
      return value as { hidden: boolean };
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json({
        tip: await setMessageHidden(
          c.env,
          session.user.id,
          c.req.param("id"),
          c.req.valid("json").hidden,
        ),
      });
    },
  )
  // A card, as anyone sees it, with what this viewer may pay with.
  .get("/tip/:code", async (c) => {
    const session = await getOptionalSession(c);
    const card = await requireCard(c.env, c.req.param("code"));
    const viewer = session
      ? { id: session.user.id, username: session.user.username }
      : null;
    const [view, viewerView] = await Promise.all([
      publicCard(c.env, card),
      viewerOf(c.env, card, viewer),
    ]);
    return c.json({ card: view, viewer: viewerView });
  })
  // Its ☕ page's 最近, a page at a time.
  .get("/tip/:code/recent", async (c) => {
    const card = await requireCard(c.env, c.req.param("code"));
    if (card.show_recent !== 1) return c.json({ rows: [], cursor: null });
    const before = (() => {
      try {
        const [at, id] = JSON.parse(atob(c.req.query("cursor") ?? "")) as [
          unknown,
          unknown,
        ];
        return typeof at === "number" && typeof id === "string"
          ? { at, id }
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const rows = await recentOf(
      c.env,
      card.id,
      TIP_LIMITS.recentPage + 1,
      before,
    );
    const page = rows.slice(0, TIP_LIMITS.recentPage);
    const last = page.at(-1);
    return c.json({
      rows: page,
      cursor:
        rows.length > TIP_LIMITS.recentPage && last
          ? btoa(JSON.stringify([last.at, last.id]))
          : null,
    });
  })
  // A tip. Signed in: the session (and its CSRF token). A guest (no session,
  // as in an embed outside the 社区): Credit 站 only, after Cap.
  .post("/tip/:code", body, json(createTipSchema, "INVALID_TIP"), async (c) => {
    const input = c.req.valid("json");
    const card = await requireCard(c.env, c.req.param("code"));
    const session = await getOptionalSession(c);
    let tipper: { id: string; username: string } | null = null;
    if (session) {
      const protectedSession = await requireProtectedMutation(c);
      tipper = {
        id: protectedSession.user.id,
        username: protectedSession.user.username,
      };
    } else {
      if (input.method !== "checkout")
        tipError(403, "TIP_SIGN_IN", "登录以后才能免密打赏。");
      const passed =
        input.capToken !== undefined &&
        (await verifyCapToken(
          c.env,
          input.capToken,
          `tip:${card.code}`,
          card.id,
        ));
      if (!passed)
        tipError(403, "TIP_HUMAN_CHECK", "人机验证没有通过，请再试一次。");
    }
    const embed = c.req.query("via") === "embed";
    return c.json(
      await createTip(
        c.env,
        card,
        tipper,
        input,
        embed ? "embed" : "web",
        requireAppOrigin(c.env),
      ),
    );
  })
  // “查一下”, the card's own asking, and the receipt page: one tip, checked.
  .post("/tip/:code/tips/:id/check", async (c) => {
    const card = await requireCard(c.env, c.req.param("code"));
    const session = await getOptionalSession(c);
    return c.json(
      await checkTipOnCard(
        c.env,
        card.id,
        c.req.param("id"),
        session?.user.id ?? null,
      ),
    );
  })
  .get("/tip/:code/tips/:id", async (c) =>
    c.json({
      receipt: await receiptOf(c.env, c.req.param("code"), c.req.param("id")),
    }),
  );
