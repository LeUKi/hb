import type { RosterKind, RosterPage } from "../../../web/src/lib/roster-read";
import { readRoster } from "../api";
import { getSdk } from "../sdk";

// Built in place of apps/web/src/lib/roster-read.ts (vite.config.ts): the
// 名单 through the forum's endpoint, always as everyone sees it (the
// sender's own view stays on 红包站, docs/mini-app-design.md §7).
export function readRosterPage({
  activityId,
  kind,
  cursor,
}: {
  activityId: string;
  kind: RosterKind;
  cursor: string | null;
  author: boolean;
  signal: AbortSignal;
}): Promise<RosterPage> {
  const sdk = getSdk();
  if (!sdk) return Promise.reject(new Error("社区小程序的 SDK 不在。"));
  return readRoster(sdk, activityId, kind, cursor);
}
