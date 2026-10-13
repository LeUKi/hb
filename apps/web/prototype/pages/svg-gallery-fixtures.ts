import {
  type ActivityImagePaymentStatus,
  type ActivityImagePresentation,
  type ActivityImageViewerState,
  activityImagePresentation,
  type PublicActivity,
} from "@hb/contracts";

export const SVG_GALLERY_LOADED_AT = "2026-10-13T03:20:00.000Z";
const CLAIMED_AT = "2026-10-13T03:14:18.000Z";
const OPENED_AT = "2026-10-13T02:20:00.000Z";
const DEADLINE_AT = "2026-10-13T11:20:00.000Z";
const ENDED_AT = "2026-10-13T02:50:00.000Z";

export type SvgGalleryCategory =
  | "business"
  | "amount"
  | "payment"
  | "quantity"
  | "snapshot"
  | "edge";

export type SvgGalleryFixture = {
  id: string;
  category: SvgGalleryCategory;
  label: string;
  description: string;
  projection: ActivityImagePresentation;
  lockSnapshotAge?: boolean;
};

type Quantity = PublicActivity["quantity"];
type RewardMode = NonNullable<PublicActivity["reward"]>["mode"];

const categoryOrder: SvgGalleryCategory[] = [
  "business",
  "amount",
  "payment",
  "quantity",
  "snapshot",
  "edge",
];

export const svgGalleryCategoryLabels: Record<
  SvgGalleryCategory | "all",
  string
> = {
  all: "全部",
  business: "业务状态",
  amount: "金额模式",
  payment: "付款状态",
  quantity: "数量展示",
  snapshot: "快照新鲜度",
  edge: "边界文本",
};

export const svgGalleryCategories = categoryOrder;

const author = {
  id: "local-demo-author",
  username: "local_demo",
  displayName: "本地示例发起人",
  avatarUrl: null,
  accountTier: "standard" as const,
};

function activity({
  id,
  title,
  status = "active",
  quantity,
  mode = "fixed",
  totalAmount = "72.00",
  unitAmount = "3.00",
  count = 24,
  draw,
}: {
  id: string;
  title: string;
  status?: PublicActivity["status"];
  quantity?: Quantity;
  mode?: RewardMode;
  totalAmount?: string;
  unitAmount?: string;
  count?: number;
  draw?: PublicActivity["draw"];
}): PublicActivity {
  return {
    id,
    title,
    rewardType: "ldc",
    status,
    author,
    forceDedicated: false,
    topicUrl: null,
    openedAt: status === "draft" ? null : OPENED_AT,
    deadlineAt: status === "ended" ? ENDED_AT : DEADLINE_AT,
    quantity: quantity ?? {
      mode: "exact",
      total: count,
      claimed: Math.min(9, Math.max(0, count - 1)),
      remaining: Math.max(1, count - 9),
    },
    reward: {
      mode,
      totalAmount,
      unitAmount,
      count,
      ...(mode === "random" ? { algorithm: "bounded_mean_v1" as const } : {}),
      ...(mode === "timed_draw"
        ? { participantLimit: count, distributeFullPool: true }
        : {}),
    },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo: "本地示例数据，不连接真实活动。",
    afterEndInfo: "本地示例结束说明。",
    paymentMode: "simulation",
    showRecipientAmount: true,
    draw,
  };
}

function projected({
  id,
  category,
  label,
  description,
  activity: publicActivity,
  viewer,
  updatedAt = SVG_GALLERY_LOADED_AT,
  publicFallback = false,
  lockSnapshotAge = false,
}: {
  id: string;
  category: SvgGalleryCategory;
  label: string;
  description: string;
  activity: PublicActivity;
  viewer?: ActivityImageViewerState;
  updatedAt?: string;
  publicFallback?: boolean;
  lockSnapshotAge?: boolean;
}): SvgGalleryFixture {
  return {
    id,
    category,
    label,
    description,
    lockSnapshotAge,
    projection: activityImagePresentation({
      activity: publicActivity,
      viewer,
      updatedAt,
      now: SVG_GALLERY_LOADED_AT,
      animated: true,
      publicFallback,
    }),
  };
}

function direct(
  fixture: Omit<SvgGalleryFixture, "projection"> & {
    projection: Omit<ActivityImagePresentation, "updatedAt" | "now"> &
      Partial<Pick<ActivityImagePresentation, "updatedAt" | "now">>;
  },
): SvgGalleryFixture {
  return {
    ...fixture,
    projection: {
      ...fixture.projection,
      updatedAt: fixture.projection.updatedAt ?? SVG_GALLERY_LOADED_AT,
      now: fixture.projection.now ?? SVG_GALLERY_LOADED_AT,
      animated: fixture.projection.animated ?? true,
    },
  };
}

function base(id: string, title: string) {
  return activity({ id: `svg-gallery-${id}`, title });
}

function claimedFixture(
  id: string,
  label: string,
  descriptionLabel: string,
  paymentStatus: ActivityImagePaymentStatus,
) {
  return projected({
    id,
    category: "payment",
    label,
    description: `本地示例 · 已领取结果，付款状态 ${descriptionLabel}`,
    activity: base(id, "付款状态样例"),
    viewer: {
      kind: "claimed",
      amount: "8.88",
      claimedAt: CLAIMED_AT,
      paymentStatus,
    },
  });
}

export const svgGalleryFixtures: SvgGalleryFixture[] = [
  direct({
    id: "neutral-blank",
    category: "business",
    label: "空白红包",
    description: "本地示例 · 空白中性红包，占位或未绑定活动时使用",
    projection: {
      id: "svg-gallery-neutral-blank",
      title: "",
      sender: "",
      state: "neutral",
      sealLabel: "",
    },
  }),
  projected({
    id: "eligible-open",
    category: "business",
    label: "可领取",
    description: "本地示例 · 可直接领取的进行中活动",
    activity: base("eligible-open", "直接开红包"),
    viewer: { kind: "eligible", action: "claim" },
  }),
  projected({
    id: "public-view",
    category: "business",
    label: "公共查看",
    description: "本地示例 · 未登录或公共视角查看活动",
    activity: base("public-view", "公共广场活动"),
    viewer: { kind: "public" },
  }),
  projected({
    id: "eligible-register",
    category: "business",
    label: "可报名",
    description: "本地示例 · 限时开奖活动可报名",
    activity: activity({
      id: "svg-gallery-eligible-register",
      title: "限时开奖报名",
      mode: "timed_draw",
      count: 8,
      draw: {
        state: "waiting",
        deadlineAt: DEADLINE_AT,
        closedAt: null,
        reason: null,
        registeredCount: 5,
        winnerCount: null,
        participantLimit: 40,
      },
      quantity: { mode: "exact", total: 40, claimed: 5, remaining: 35 },
    }),
    viewer: { kind: "eligible", action: "register" },
  }),
  projected({
    id: "registered",
    category: "business",
    label: "已报名",
    description: "本地示例 · 已报名等待开奖",
    activity: base("registered", "报名成功"),
    viewer: { kind: "registered", registeredAt: "2026-10-13T02:48:00.000Z" },
  }),
  projected({
    id: "drawing",
    category: "business",
    label: "开奖中",
    description: "本地示例 · 开奖结算中",
    activity: activity({
      id: "svg-gallery-drawing",
      title: "正在开奖",
      mode: "timed_draw",
      draw: {
        state: "settling",
        deadlineAt: DEADLINE_AT,
        closedAt: null,
        reason: "deadline",
        registeredCount: 31,
        winnerCount: null,
      },
    }),
    viewer: { kind: "drawing" },
  }),
  projected({
    id: "claimed",
    category: "business",
    label: "已领取",
    description: "本地示例 · 已中奖或已领取的结果页",
    activity: base("claimed", "领取成功"),
    viewer: {
      kind: "claimed",
      amount: "6.66",
      claimedAt: CLAIMED_AT,
      paymentStatus: "confirmed",
    },
  }),
  direct({
    id: "claimed-closed",
    category: "business",
    label: "领取闭合态",
    description: "本地示例 · 已领取红包开封前的闭合观察态",
    projection: {
      id: "svg-gallery-claimed-closed",
      title: "领取结果待展开",
      sender: "本地示例发起人",
      state: "claimed",
      sealLabel: "开",
      amount: "6.66 LDC",
      statusText: "已发放",
      claimedAt: CLAIMED_AT,
      revealPhase: "closed",
    },
  }),
  direct({
    id: "claimed-open",
    category: "business",
    label: "领取展开态",
    description: "本地示例 · 已领取红包开封后的静态观察态",
    projection: {
      id: "svg-gallery-claimed-open",
      title: "领取结果已展开",
      sender: "本地示例发起人",
      state: "claimed",
      sealLabel: "开",
      amount: "6.66 LDC",
      statusText: "已发放",
      claimedAt: CLAIMED_AT,
      revealPhase: "open",
    },
  }),
  projected({
    id: "ended",
    category: "business",
    label: "已结束",
    description: "本地示例 · 活动已结束",
    activity: activity({
      id: "svg-gallery-ended",
      title: "活动已结束",
      status: "ended",
    }),
    viewer: { kind: "ended" },
  }),
  projected({
    id: "not-won",
    category: "business",
    label: "未中奖",
    description: "本地示例 · 开奖后未中奖",
    activity: base("not-won", "差一点中奖"),
    viewer: { kind: "not_won" },
  }),
  direct({
    id: "draft-preview",
    category: "business",
    label: "草稿预览",
    description: "本地示例 · 草稿预览，不代表已发布活动",
    projection: {
      id: "svg-gallery-draft-preview",
      title: "草稿预览标题",
      sender: "本地示例发起人",
      state: "neutral",
      sealLabel: "预览",
    },
  }),
  ...(["loading", "pending", "error", "unavailable"] as const).map((state) =>
    projected({
      id: state,
      category: "business",
      label:
        state === "loading"
          ? "读取中"
          : state === "pending"
            ? "处理中"
            : state === "error"
              ? "读取失败"
              : "不可用",
      description: `本地示例 · ${
        state === "loading"
          ? "正在读取活动图片"
          : state === "pending"
            ? "提交后等待状态确认"
            : state === "error"
              ? "读取活动图片失败"
              : "活动图片暂不可用"
      }`,
      activity: base(state, "读取状态样例"),
      viewer: { kind: state },
    }),
  ),
  projected({
    id: "public-fallback",
    category: "business",
    label: "公共后备图",
    description: "本地示例 · 公共后备图，不暴露动态数量",
    activity: base("public-fallback", "公共后备图"),
    publicFallback: true,
  }),

  projected({
    id: "amount-fixed",
    category: "amount",
    label: "固定均分",
    description: "本地示例 · 固定均分，每份 2.00 LDC",
    activity: activity({
      id: "svg-gallery-amount-fixed",
      title: "固定均分 2.00 LDC",
      mode: "fixed",
      unitAmount: "2.00",
      totalAmount: "60.00",
      count: 30,
    }),
    viewer: { kind: "eligible", action: "claim" },
  }),
  projected({
    id: "amount-custom",
    category: "amount",
    label: "自定义金额",
    description: "本地示例 · 自定义金额列表",
    activity: activity({
      id: "svg-gallery-amount-custom",
      title: "自定义金额红包",
      mode: "custom",
      totalAmount: "128.80",
      count: 16,
    }),
    viewer: { kind: "eligible", action: "claim" },
  }),
  projected({
    id: "amount-random",
    category: "amount",
    label: "拼手气随机",
    description: "本地示例 · 拼手气随机金额",
    activity: activity({
      id: "svg-gallery-amount-random",
      title: "拼手气随机红包",
      mode: "random",
      totalAmount: "88.88",
      count: 24,
    }),
    viewer: { kind: "eligible", action: "claim" },
  }),
  projected({
    id: "amount-timed-draw",
    category: "amount",
    label: "限时开奖",
    description: "本地示例 · 限时开奖奖池",
    activity: activity({
      id: "svg-gallery-amount-timed-draw",
      title: "限时开奖奖池",
      mode: "timed_draw",
      totalAmount: "200.00",
      count: 10,
      draw: {
        state: "waiting",
        deadlineAt: DEADLINE_AT,
        closedAt: null,
        reason: null,
        registeredCount: 18,
        winnerCount: null,
        participantLimit: 60,
      },
    }),
    viewer: { kind: "eligible", action: "register" },
  }),

  claimedFixture("payment-pending", "待付款", "待付款", "pending"),
  claimedFixture("payment-sending", "发送中", "发送中", "sending"),
  claimedFixture("payment-reconciling", "核对中", "核对中", "reconciling"),
  claimedFixture("payment-waiting", "等待确认", "等待确认", "waiting"),
  claimedFixture("payment-confirmed", "已发放", "已发放", "confirmed"),
  claimedFixture("payment-attention", "需要关注", "需要关注", "attention"),
  claimedFixture("payment-null", "未返回付款状态", "未返回", null),

  ...(
    [
      [
        "quantity-exact",
        "精确剩余",
        {
          mode: "exact",
          total: 50,
          claimed: 12,
          remaining: 38,
        } satisfies Quantity,
      ],
      [
        "quantity-fuzzy-plenty",
        "名额充足",
        { mode: "fuzzy", level: "plenty" } satisfies Quantity,
      ],
      [
        "quantity-fuzzy-limited",
        "名额有限",
        { mode: "fuzzy", level: "limited" } satisfies Quantity,
      ],
      [
        "quantity-fuzzy-low",
        "名额不多",
        { mode: "fuzzy", level: "low" } satisfies Quantity,
      ],
      [
        "quantity-fuzzy-empty",
        "名额已满",
        { mode: "fuzzy", level: "empty" } satisfies Quantity,
      ],
      [
        "quantity-availability",
        "仅显示可参与",
        { mode: "availability", available: true } satisfies Quantity,
      ],
      [
        "quantity-availability-full",
        "暂无名额",
        { mode: "availability", available: false } satisfies Quantity,
      ],
      ["quantity-hidden", "隐藏数量", { mode: "hidden" } satisfies Quantity],
    ] as const
  ).map(([id, label, quantity]) =>
    projected({
      id,
      category: "quantity",
      label,
      description: `本地示例 · ${label}`,
      activity: activity({
        id: `svg-gallery-${id}`,
        title: "数量展示样例",
        quantity,
      }),
      viewer: { kind: "eligible", action: "claim" },
    }),
  ),

  ...([0, 10, 30, 60] as const).map((seconds) =>
    projected({
      id: `snapshot-${seconds}`,
      category: "snapshot",
      label: `快照 ${seconds} 秒`,
      description: `本地示例 · 固定快照年龄 ${seconds} 秒`,
      activity: base(`snapshot-${seconds}`, `快照 ${seconds} 秒`),
      viewer: { kind: "eligible", action: "claim" },
      updatedAt: new Date(
        Date.parse(SVG_GALLERY_LOADED_AT) - seconds * 1000,
      ).toISOString(),
      lockSnapshotAge: true,
    }),
  ),

  direct({
    id: "long-sender",
    category: "edge",
    label: "长发起人",
    description: "本地示例 · 发起人名称很长时的截断",
    projection: {
      id: "svg-gallery-long-sender",
      title: "正常标题",
      sender: "本地示例发起人名称非常非常长",
      state: "active",
      sealLabel: "开",
      quantityText: "剩余 12 份",
    },
  }),
  direct({
    id: "long-title",
    category: "edge",
    label: "长标题",
    description: "本地示例 · 长标题自动拆行",
    projection: {
      id: "svg-gallery-long-title",
      title: "这是一个很长很长的红包标题用于检查展示换行和裁切",
      sender: "本地示例发起人",
      state: "active",
      sealLabel: "开",
      quantityText: "仍可参与",
    },
  }),
  direct({
    id: "large-amount",
    category: "edge",
    label: "大额金额",
    description: "本地示例 · 大额结果的字号适配",
    projection: {
      id: "svg-gallery-large-amount",
      title: "大额奖励",
      sender: "本地示例发起人",
      state: "claimed",
      sealLabel: "开",
      amount: "1234567.89 LDC",
      statusText: "已发放",
      claimedAt: CLAIMED_AT,
    },
  }),
];
