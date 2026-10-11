import { getActivityPublicMetadata } from "./activity-metadata";
import type { Activity } from "./types";

export type ActivityShareOptions = {
  fuzzy?: boolean;
  includePasswords?: boolean;
  url: string;
};

export function buildActivityShareText(
  activity: Activity,
  { fuzzy = false, includePasswords = false, url }: ActivityShareOptions,
) {
  const metadata = getActivityPublicMetadata(activity, { fuzzy });
  const summary = [
    metadata.rewardLabel,
    ...(metadata.poolLabel ? [`总奖池 ${metadata.poolLabel}`] : []),
    metadata.countLabel,
  ].join(" · ");
  const lines = [activity.title, summary, `领取链接：${url}`];
  if (includePasswords && activity.passwords.length > 0)
    lines.push("活动口令：", ...activity.passwords);
  return lines.join("\n");
}
