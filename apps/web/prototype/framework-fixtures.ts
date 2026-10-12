import { fixedPoolAmount, prototypeDeadlineAt } from "./activity-metadata";
import { activities, historySamples, randomActivities } from "./fixtures";
import type { Activity } from "./types";

// Extra local records exercise the shell's scrolling and realistic text lengths.
const samples: Array<[string, string, string, Activity["type"]]> = [
  ["开源工具分享 · 第一批红包", "陈同学", "chen", "ldc"],
  ["周二晚间限时开奖", "北岸", "north", "draw"],
  ["新版本发布纪念", "十一", "eleven", "ldc"],
  ["Linux 命令速查手册领取", "经常忘记命令的开发者", "terminal", "ldc"],
  ["社区读书活动", "Morgan", "Morgan", "ldc"],
  ["周末限时开奖 · 第二期", "叶子", "leaf", "draw"],
  ["工具箱 Pro 红包（仅限新用户）", "小田", "field", "ldc"],
  ["十月活动", "Neko", "Neko", "ldc"],
  [
    "自建服务实践资料包：部署、备份与维护清单",
    "一个名字有点长的论坛用户",
    "longname",
    "ldc",
  ],
  ["晚间红包", "云杉", "spruce", "ldc"],
  ["图标素材红包", "Robin", "Robin", "ldc"],
  ["周末分享会", "清秋", "autumn", "draw"],
  ["小工具合集领取", "Alex", "Alex", "ldc"],
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
      amount: type === "draw" ? "10.00" : "0.10",
      rewardMode: type === "draw" ? "timed_draw" : "fixed",
      poolAmount:
        type === "draw" ? "10.00" : (fixedPoolAmount("0.10", 20) ?? undefined),
      deadlineAt: prototypeDeadlineAt(type),
      count: 20,
      remaining: 12,
      passwords: [`工具体验口令${index + 1}`],
    }),
  ),
  ...historySamples,
];
