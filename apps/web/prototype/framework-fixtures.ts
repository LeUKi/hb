import { fixedPoolAmount, prototypeDeadlineAt } from "./activity-metadata";
import { activities, historySamples, randomActivities } from "./fixtures";
import type { Activity } from "./types";

// Extra local records exercise the shell's scrolling and realistic text lengths.
const samples: Array<[string, string, string, Activity["type"]]> = [
  ["开源工具分享 · 第一批兑换码", "陈同学", "chen", "text"],
  ["周二晚间限时开奖", "北岸", "north", "draw"],
  ["新版本发布纪念", "十一", "eleven", "ldc"],
  ["Linux 命令速查手册兑换", "经常忘记命令的开发者", "terminal", "text"],
  ["社区读书活动", "Morgan", "Morgan", "ldc"],
  ["周末限时开奖 · 第二期", "叶子", "leaf", "draw"],
  ["工具箱 Pro 试用码（仅限新用户）", "小田", "field", "text"],
  ["十月活动", "Neko", "Neko", "ldc"],
  [
    "自建服务实践资料包：部署、备份与维护清单",
    "一个名字有点长的论坛用户",
    "longname",
    "text",
  ],
  ["晚间红包", "云杉", "spruce", "ldc"],
  ["图标素材授权码", "Robin", "Robin", "text"],
  ["周末分享会", "清秋", "autumn", "draw"],
  ["小工具合集兑换", "Alex", "Alex", "text"],
  ["十月第二场红包", "点点", "dot", "ldc"],
];

export const gallerySamples: Activity[] = [
  ...activities,
  ...randomActivities,
  ...samples.map(
    ([title, author, username, type], index): Activity => ({
      id: `sample-${index + 1}`,
      title,
      author,
      username,
      color: "sage",
      type,
      description: "每个账号可参与一次。",
      amount: type === "draw" ? "10.00" : type === "ldc" ? "0.10" : "",
      rewardMode:
        type === "draw" ? "timed_draw" : type === "ldc" ? "fixed" : undefined,
      poolAmount:
        type === "draw"
          ? "10.00"
          : type === "ldc"
            ? (fixedPoolAmount("0.10", 20) ?? undefined)
            : undefined,
      deadlineAt: prototypeDeadlineAt(type),
      count: 20,
      remaining: 12,
      passwords: [`工具体验口令${index + 1}`],
    }),
  ),
  ...historySamples,
];
