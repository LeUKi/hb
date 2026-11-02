import type {
  ActivityParticipationResponse,
  PublicActivity,
  PublicRecipientList,
  PublicRegistrationList,
} from "./index";

// 社区小程序 (docs/mini-app-design.md §7): LINUX DO's mini app for a 红包,
// opened from a forum link that names it, to claim it inside the forum.

/** The forum app's id, as its app page gave it (public: it is in its address). */
export const FORUM_MINI_APP_ID = "01a19ba5-b9d2-766f-9fb9-b7eddc10e0c7";
/** The forum, which signs the mini app's requests. */
export const FORUM_ORIGIN = "https://linux.do";
/** The launch parameter that names the 红包. */
export const MINI_APP_HONGBAO_PARAM = "hb";

/** 社区小程序链接: this 红包 in the forum's mini app. */
export function forumMiniAppLink(activityId: string) {
  return `${FORUM_ORIGIN}/apps/${FORUM_MINI_APP_ID}?${MINI_APP_HONGBAO_PARAM}=${encodeURIComponent(activityId)}`;
}

/**
 * GET /api/mini/hongbao?id=: the 红包, without what the mini app never
 * shows (its code, its page, its proof), and the viewer's own part.
 */
export type MiniHongbaoResponse = {
  activity: PublicActivity;
  participation: Pick<ActivityParticipationResponse, "claim" | "registration">;
  /**
   * They have an account here (signed in once, or made from the forum by an
   * earlier claim). Without one the first claim makes it.
   */
  known: boolean;
  /** They sent it: their first share is asked about first (自领). */
  author: boolean;
  /**
   * A sandbox build on the production site (its author or the 社区's
   * reviewers checking it): it shows the 红包, nobody can claim.
   */
  lookOnly: boolean;
};

/**
 * GET /api/mini/roster?id=&kind=claims|registrations&cursor=: the 名单 as
 * 红包站 shows everyone, 20 at a time (the sender's own view, with 口令 and
 * payments, stays on 红包站).
 */
export type MiniRosterKind = "claims" | "registrations";
export type MiniRosterPage = PublicRecipientList | PublicRegistrationList;

/**
 * POST /api/mini/claim?id=: a claim, or a timed draw's sign-up. `forumUser`
 * is what the forum told the app (sdk.user.getCurrent()): it names an
 * account made for a first-timer; who they are is the token's id.
 */
export type MiniClaimInput = {
  submissionId: string;
  password?: string;
  forumUser?: { username: string; name: string };
};

/**
 * What a 红包's live channel sends a mini app's socket, each under
 * MINI_LIVE_LIMIT bytes: its public read without the parts that do not
 * move while it runs (or `changed` when even that is too long: read it
 * again), how many people watch, and that their own part moved.
 */
export type MiniLiveActivity = Omit<
  PublicActivity,
  | "beforeInfo"
  | "afterEndInfo"
  | "rosterPreview"
  | "judge"
  | "page"
  | "drawProof"
>;
export type MiniLiveMessage =
  | { type: "activity"; activity: MiniLiveActivity; seq: number }
  | { type: "changed"; seq: number }
  | { type: "viewers"; count: number; seq: number }
  | { type: "mine" };

/** The forum's limit on one WebSocket message. */
export const MINI_LIVE_LIMIT = 4096;
