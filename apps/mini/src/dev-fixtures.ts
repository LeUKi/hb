import type {
  ClaimDetail,
  ClaimResult,
  MiniHongbaoResponse,
  MiniRosterKind,
  MiniRosterPage,
  PublicActivity,
} from "@hb/contracts";

// Local only (src/dev.tsx): 红包 the stand-in SDK answers for, one per case
// the page draws, picked by the link's `?hb=`. Never in app.js.

const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const author = {
  id: "author",
  username: "lafish",
  displayName: "lafish",
  avatarUrl: null,
};

function hongbao(
  id: string,
  extra: Partial<PublicActivity> = {},
): PublicActivity {
  return {
    id,
    title: "周末红包",
    rewardType: "ldc",
    participationMode: "password",
    status: "active",
    author,
    forceDedicated: false,
    topicUrl: null,
    openedAt: iso(-600_000),
    deadlineAt: iso(2 * 3_600_000 - 19_000),
    quantity: { mode: "exact", total: 10, claimed: 3, remaining: 7 },
    reward: {
      mode: "random",
      totalAmount: "100.00",
      count: 10,
      algorithm: "double_mean_v1",
    },
    beforeInfo:
      "论坛里也能领了。口令是「**你好论坛**」，[红包站](https://hb.lafi.sh)上也行。",
    paymentMode: "simulation",
    ...extra,
  };
}

export type Case = {
  read: MiniHongbaoResponse;
  /** What a claim answers, by the 口令 typed (or none). */
  claim?: (password: string | undefined) => ClaimResult;
};

const ids = {
  password: "11111111-2222-4333-8444-555555555501",
  direct: "11111111-2222-4333-8444-555555555502",
  fish: "11111111-2222-4333-8444-555555555503",
  draw: "11111111-2222-4333-8444-555555555504",
  code: "11111111-2222-4333-8444-555555555505",
  human: "11111111-2222-4333-8444-555555555506",
  ended: "11111111-2222-4333-8444-555555555507",
  stranger: "11111111-2222-4333-8444-555555555508",
  taken: "11111111-2222-4333-8444-555555555510",
  scheduled: "11111111-2222-4333-8444-555555555509",
  self: "11111111-2222-4333-8444-555555555511",
} as const;

export type CaseName = keyof typeof ids;
export const caseNames = Object.keys(ids) as CaseName[];

const none = { claim: null, registration: null };

function claimOf(activity: PublicActivity, amount: string): ClaimDetail {
  return {
    id: crypto.randomUUID(),
    activity: {
      id: activity.id,
      title: activity.title,
      status: activity.status,
      ...(activity.funding ? { funding: activity.funding } : {}),
    },
    rewardType: "ldc",
    claimedAt: new Date().toISOString(),
    amount,
    afterClaimInfo: "谢谢来领，周末愉快！",
    ...(activity.funding === "balance"
      ? {}
      : {
          payment: {
            id: crypto.randomUUID(),
            mode: "simulation",
            status: "pending",
            reason: null,
            confirmedAt: null,
          },
        }),
  };
}

export function caseOf(name: string): Case | null {
  switch (name) {
    case "password": {
      const activity = hongbao(ids.password);
      return {
        read: { activity, participation: none, known: true, author: false },
        claim: (password) =>
          password === "你好论坛"
            ? { result: "claimed", claim: claimOf(activity, "13.28") }
            : { result: "incorrect" },
      };
    }
    case "direct": {
      const activity = hongbao(ids.direct, {
        title: "无需口令，直接领",
        participationMode: "direct",
        reward: {
          mode: "fixed",
          totalAmount: "20.00",
          unitAmount: "2.00",
          count: 10,
        },
        beforeInfo: "点「开」直接领。",
      });
      return {
        read: { activity, participation: none, known: true, author: false },
        claim: () => ({ result: "claimed", claim: claimOf(activity, "2.00") }),
      };
    }
    case "fish": {
      const activity = hongbao(ids.fish, {
        title: "🐟额红包",
        participationMode: "direct",
        funding: "balance",
        beforeInfo: "领到的先存进🐟额。",
      });
      return {
        read: { activity, participation: none, known: true, author: false },
        claim: () => ({ result: "claimed", claim: claimOf(activity, "8.80") }),
      };
    }
    case "draw": {
      const activity = hongbao(ids.draw, {
        title: "周五晚上开奖",
        participationMode: "direct",
        quantity: { mode: "hidden" },
        reward: {
          mode: "timed_draw",
          totalAmount: "50.00",
          count: 5,
          algorithm: "double_mean_v1",
        },
        draw: {
          state: "waiting",
          deadlineAt: iso(5 * 3_600_000),
          closedAt: null,
          reason: null,
          registeredCount: 12,
          winnerCount: null,
          participantLimit: 100,
        },
        beforeInfo: "报名后到点抽 5 个人。",
      });
      return {
        read: { activity, participation: none, known: true, author: false },
        claim: () => ({
          result: "registered",
          registration: {
            id: crypto.randomUUID(),
            activity: {
              id: activity.id,
              title: activity.title,
              status: "active",
            },
            registeredAt: new Date().toISOString(),
            status: "registered",
            drawAt: activity.draw?.deadlineAt ?? null,
            claim: null,
          },
        }),
      };
    }
    case "code":
      return {
        read: {
          activity: hongbao(ids.code, {
            title: "矿洞夺宝 · 多人试玩",
            participationMode: "code",
            quantity: { mode: "pool", left: "86.50" },
            reward: { mode: "code", totalAmount: "100.00" },
            judge: {
              protocol: 5,
              prompt: "点格子挖宝",
              seedCommitment: "seed",
              judged: 1284,
              unclaimed: "86.50",
            },
            beforeInfo: "大家共享一张矿洞卡，点格子挖宝。",
          }),
          participation: none,
          known: true,
          author: false,
        },
      };
    case "human":
      return {
        read: {
          activity: hongbao(ids.human, {
            title: "需要人机验证的红包",
            participationMode: "direct",
            humanCheck: true,
            beforeInfo: "红包作者要求领取前先通过人机验证。",
          }),
          participation: none,
          known: true,
          author: false,
        },
      };
    case "ended":
      return {
        read: {
          activity: hongbao(ids.ended, {
            title: "已经领完的红包",
            status: "ended",
            quantity: { mode: "exact", total: 10, claimed: 10, remaining: 0 },
          }),
          participation: none,
          known: true,
          author: false,
        },
      };
    case "stranger":
    case "taken": {
      const activity = hongbao(ids[name], { title: "第一次在论坛里领" });
      return {
        read: { activity, participation: none, known: false, author: false },
        claim: (password) =>
          password === "你好论坛"
            ? { result: "claimed", claim: claimOf(activity, "6.66") }
            : { result: "incorrect" },
      };
    }
    case "scheduled":
      return {
        read: {
          activity: hongbao(ids.scheduled, {
            title: "晚上八点开放",
            status: "draft",
            openedAt: null,
            deadlineAt: null,
            scheduledOpenAt: iso(3 * 3_600_000),
            draftDeadline: { mode: "duration", value: 1, unit: "hours" },
          }),
          participation: none,
          known: true,
          author: false,
        },
      };
    case "self": {
      // Their own: the seal asks first (自领).
      const activity = hongbao(ids.self, {
        title: "自己发的🐟额红包",
        participationMode: "direct",
        funding: "balance",
        beforeInfo: "发红包的人自己也能领一份。",
      });
      return {
        read: { activity, participation: none, known: true, author: true },
        claim: () => ({ result: "claimed", claim: claimOf(activity, "8.80") }),
      };
    }
    default:
      return null;
  }
}

const names = ["阿离", "BigFish", "小周", "momo", "老王", "Kiki", "七七"];

/** 名单: 26 people for a claim list (two pages), 12 for a draw's sign-ups. */
export function rosterPage(
  kind: MiniRosterKind,
  cursor: string | undefined,
): MiniRosterPage {
  const start = cursor ? Number(cursor) : 0;
  const total = kind === "claims" ? 26 : 12;
  const end = Math.min(total, start + 20);
  const people = Array.from({ length: end - start }, (_, index) => {
    const n = start + index;
    const name = `${names[n % names.length]}${n >= names.length ? n : ""}`;
    return {
      id: `person-${n}`,
      username: `user${n}`,
      displayName: name,
      avatarUrl: null,
    };
  });
  const nextCursor = end < total ? String(end) : null;
  if (kind === "registrations")
    return {
      items: people.map((person, index) => ({
        ...person,
        registeredAt: iso(-500_000 + (start + index) * 9_000),
      })),
      nextCursor,
    };
  // The forum's lafish (dev.tsx) among them, with each 称号 once.
  const titled = {
    0: { username: "lafish", displayName: "lafish", self: true },
    1: { speedTitle: "fastest" },
    3: { title: "highest" },
    5: { title: "lowest" },
  } as const;
  return {
    items: people.map((person, index) => ({
      ...person,
      claimedAt: iso(-500_000 + (start + index) * 7_000),
      amount: ((((start + index) * 37) % 900) / 100 + 1).toFixed(2),
      ...titled[(start + index) as keyof typeof titled],
    })),
    nextCursor,
  };
}
