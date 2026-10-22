import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { normalizeActivityUuid } from "@/lib/ecoji-v2";
import { Shell } from "./components/shell/shell";
import {
  activityCode,
  activityIdFromCode,
  restoreForumEmojiAddress,
  type SenderPage,
} from "./lib/activity-route";
import type { CommandId } from "./lib/commands";

// Routes carry no components: the shell renders views itself so it can run
// enter/exit animations and keep the single omnibox outside the views.
// Addresses (docs/redesign/03 §7): 红包 at /🧧/<emoji code>, the two result
// pages at /🔑/<result> and /💬/<topic>/<post>, every other page an English
// "/" command path. The retired /activities/…, /e/…, /redeem/… and /topics/…
// addresses fall to "not found".

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** "start": omnibox centred on the start page; "docked": in the bar. */
    chrome?: "start" | "docked";
    /** The command whose page this route shows. */
    command?: CommandId;
    /** A sender's page under a 红包 (📝 / 📊 / 🧾). */
    senderPage?: SenderPage;
    /** A page without a command of its own (/payments/<编号>, /status): its title. */
    subpage?: string;
  }
  interface Register {
    router: typeof router;
  }
}

const rootRoute = createRootRoute({ component: Shell });

const startRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  staticData: { chrome: "start" },
});
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/🧧/$code",
  staticData: { chrome: "docked" },
  beforeLoad: ({ params }) => {
    // Non-canonical spellings (e.g. extra variation selectors) and a bare
    // UUID settle on one address.
    const id =
      activityIdFromCode(params.code) ?? normalizeActivityUuid(params.code);
    if (id && params.code !== activityCode(id)) {
      throw redirect({
        to: "/🧧/$code",
        params: { code: activityCode(id) },
        replace: true,
      });
    }
  },
});
// The sender's pages: the same code check as the 红包 itself, so a loose
// spelling or a bare UUID settles on the one address.
const senderRoute = (emoji: string, page: SenderPage) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/🧧/$code/${emoji}`,
    staticData: { chrome: "docked", senderPage: page },
    beforeLoad: ({ params }) => {
      const id =
        activityIdFromCode(params.code) ?? normalizeActivityUuid(params.code);
      if (id && params.code !== activityCode(id)) {
        throw redirect({
          to: `/🧧/$code/${emoji}` as "/🧧/$code/📝",
          params: { code: activityCode(id) },
          replace: true,
        });
      }
    },
  });
const editRoute = senderRoute("📝", "edit");
const statsRoute = senderRoute("📊", "stats");
const paymentsOfRoute = senderRoute("🧾", "payments");
// 🎲 开奖数据 (docs/draw-proof-design.md §5): open to anyone.
const drawDataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/🧧/$code/🎲",
  staticData: { chrome: "docked", subpage: "开奖数据" },
  beforeLoad: ({ params }) => {
    const id =
      activityIdFromCode(params.code) ?? normalizeActivityUuid(params.code);
    if (id && params.code !== activityCode(id)) {
      throw redirect({
        to: "/🧧/$code/🎲",
        params: { code: activityCode(id) },
        replace: true,
      });
    }
  },
});
const redeemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/🔑/$resultId",
  staticData: { chrome: "docked" },
});
// An invitation to 转入: its own page, open to anyone with the link.
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  staticData: { chrome: "docked", subpage: "邀请" },
});
const topicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/💬/$topicId/$postNumber",
  staticData: { chrome: "docked" },
});
// A post link without a floor means the first post.
const topicFirstPostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/💬/$topicId",
  staticData: { chrome: "docked" },
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/💬/$topicId/$postNumber",
      params: { topicId: params.topicId, postNumber: "1" },
      replace: true,
    });
  },
});
const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/new",
  staticData: { chrome: "docked", command: "new" },
});
const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  staticData: { chrome: "docked", command: "history" },
});
const balanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/balance",
  staticData: { chrome: "docked", command: "balance" },
});
const squareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/square",
  staticData: { chrome: "docked", command: "square" },
});
const meRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/me",
  staticData: { chrome: "docked", command: "me" },
});
const merchantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/merchant",
  staticData: { chrome: "docked", command: "merchant" },
});
const paymentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/payments",
  staticData: { chrome: "docked", command: "payments" },
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  staticData: { chrome: "docked", command: "admin" },
});
// Pages below a command page: English paths (03 §7), same gate as the command.
const subRoute = <Path extends string>(
  path: Path,
  command: CommandId,
  title: string,
) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    staticData: { chrome: "docked", command, subpage: title },
  });
const merchantDetailRoute = subRoute(
  "/merchant/$merchantId",
  "merchant",
  "商户详情",
);
const balanceTopupRoute = subRoute("/balance/$topupId", "balance", "转入详情");
const balanceWithdrawalRoute = subRoute(
  "/balance/out/$withdrawalId",
  "balance",
  "转出详情",
);
// A 转账 to 对方的收银台 (balance-design §16): Credit 站 brings the payer back.
const balanceCheckoutRoute = subRoute(
  "/balance/pay/$checkoutId",
  "balance",
  "付款详情",
);
const paymentDetailRoute = subRoute(
  "/payments/$paymentId",
  "payments",
  "付款详情",
);
// 网站管理's pages. Filters live in the address, so the overview can link
// straight to a filtered list (and a list can be shared or reloaded).
export type AdminSearch = {
  q?: string;
  /** /admin/payments: one payment state (异常待处理 from the overview). */
  state?: string;
  /** /admin/activities and /admin/users: the status filter. */
  status?: string;
  anomaly?: string;
  /** /admin/payments: real or simulated payments only. */
  mode?: string;
  /** A user's id (发红包的人, 收款人) or a 红包's id, from another page. */
  author?: string;
  activity?: string;
  recipient?: string;
};
const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;
const adminRoute2 = <Path extends string>(path: Path, title: string) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    staticData: { chrome: "docked", command: "admin", subpage: title },
    validateSearch: (search: Record<string, unknown>): AdminSearch => ({
      q: text(search.q),
      state: text(search.state),
      status: text(search.status),
      anomaly: text(search.anomaly),
      mode: text(search.mode),
      author: text(search.author),
      activity: text(search.activity),
      recipient: text(search.recipient),
    }),
  });
const adminActivitiesRoute = adminRoute2("/admin/activities", "红包");
const adminUsersRoute = adminRoute2("/admin/users", "用户");
const adminPaymentsRoute = adminRoute2("/admin/payments", "付款");
const adminBalanceRoute = adminRoute2("/admin/balance", "🐟额");
const adminSettingsRoute = adminRoute2("/admin/settings", "网站设置");
const adminAuditRoute = adminRoute2("/admin/audit", "操作记录");
const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/help",
  staticData: { chrome: "docked", command: "help" },
});
// 🐟额开放接口 (balance-design §16): the help page's own subpage.
const helpApiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/help/api",
  staticData: { chrome: "docked", command: "help", subpage: "🐟额开放接口" },
});
// Production's connection check: kept, with no entry (06 §5).
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  staticData: { chrome: "docked", subpage: "运行状态" },
});
const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  staticData: { chrome: "docked" },
});

const routeTree = rootRoute.addChildren([
  startRoute,
  activityRoute,
  editRoute,
  statsRoute,
  paymentsOfRoute,
  drawDataRoute,
  redeemRoute,
  inviteRoute,
  topicRoute,
  topicFirstPostRoute,
  newRoute,
  historyRoute,
  squareRoute,
  meRoute,
  merchantRoute,
  merchantDetailRoute,
  paymentsRoute,
  paymentDetailRoute,
  balanceRoute,
  balanceTopupRoute,
  balanceWithdrawalRoute,
  balanceCheckoutRoute,
  adminRoute,
  adminActivitiesRoute,
  adminUsersRoute,
  adminPaymentsRoute,
  adminBalanceRoute,
  adminSettingsRoute,
  adminAuditRoute,
  helpRoute,
  helpApiRoute,
  statusRoute,
  notFoundRoute,
]);

// A link copied from a forum post has :name: for each emoji (/:red_envelope:/
// :chart_decreasing:…): the emoji go back into the address before the
// router reads it.
restoreForumEmojiAddress();

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  scrollRestoration: false,
});
