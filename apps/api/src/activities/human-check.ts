import type { HumanCheckChallenge } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { ActivityError } from "./errors";
import type { ActivityRow } from "./storage";

// 领取前人机验证: a 红包 whose author turned it on asks each claim or sign-up
// for a Cloudflare Turnstile token first. The API route checks the token
// with Siteverify before the 红包's Durable Object (whose writes queue one
// by one) sees the request; the Durable Object, which knows when a claim
// would really go ahead, asks for one (HUMAN_CHECK_REQUIRED) only then.

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 5_000;

/**
 * Cloudflare's published test site keys, each with the secret that accepts
 * its dummy token (developers.cloudflare.com/turnstile/troubleshooting/
 * testing). Local runs and Stage use them, so they need no secret.
 */
const TEST_SECRETS: Record<string, string> = {
  "1x00000000000000000000AA": "1x0000000000000000000000000000000AA",
  "2x00000000000000000000AB": "2x0000000000000000000000000000000AA",
  "1x00000000000000000000BB": "1x0000000000000000000000000000000AA",
  "2x00000000000000000000BB": "2x0000000000000000000000000000000AA",
  "3x00000000000000000000FF": "1x0000000000000000000000000000000AA",
};

export function isTestSiteKey(siteKey: string) {
  return Object.hasOwn(TEST_SECRETS, siteKey);
}

function keys(env: ApiBindings) {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secret = isTestSiteKey(siteKey)
    ? TEST_SECRETS[siteKey]
    : env.TURNSTILE_SECRET_KEY?.trim();
  return siteKey && secret ? { siteKey, secret } : null;
}

/** Whether this environment can ask for a human check at all. */
export function humanCheckAvailable(env: ApiBindings) {
  return keys(env) !== null;
}

export function humanCheckEnabled(activity: Pick<ActivityRow, "config">) {
  return (
    (JSON.parse(activity.config) as { humanCheck?: unknown }).humanCheck ===
    true
  );
}

function actionOf(activity: Pick<ActivityRow, "config">) {
  return (JSON.parse(activity.config) as { money?: { mode?: string } }).money
    ?.mode === "timed_draw"
    ? "register"
    : "claim";
}

/**
 * The check this 红包 asks for, or null. Without keys (an environment not
 * set up for it) nothing is asked: the 红包 still works.
 */
export function humanCheckOf(
  env: ApiBindings,
  activity: Pick<ActivityRow, "id" | "config">,
): HumanCheckChallenge | null {
  if (!humanCheckEnabled(activity)) return null;
  const configured = keys(env);
  if (!configured) {
    console.error("human_check_not_configured", { activityId: activity.id });
    return null;
  }
  return {
    siteKey: configured.siteKey,
    action: actionOf(activity),
    cData: activity.id,
  };
}

export class HumanCheckRequiredError extends ActivityError {
  constructor(public readonly humanCheck: HumanCheckChallenge) {
    super(
      403,
      "HUMAN_CHECK_REQUIRED",
      humanCheck.action === "register"
        ? "报名这个红包需要先通过人机验证。"
        : "领取这个红包需要先通过人机验证。",
    );
    this.name = "HumanCheckRequiredError";
  }
}

/** Where a claim or sign-up stops for a human check it has not passed. */
export function requireHumanCheck(
  env: ApiBindings,
  activity: Pick<ActivityRow, "id" | "config">,
  verified: boolean,
) {
  if (verified) return;
  const challenge = humanCheckOf(env, activity);
  if (challenge) throw new HumanCheckRequiredError(challenge);
}

type SiteverifyOutcome = {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  cdata?: unknown;
  "error-codes"?: unknown;
};

/** Siteverify codes that are this side's or Cloudflare's fault, not the token's. */
const OUR_FAULT = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
  "internal-error",
]);

/**
 * Whether a token proves a person passed this 红包's check. A token that
 * fails (wrong, spent, expired, for another 红包) does not; when
 * Siteverify itself cannot answer, the claim goes ahead and it is logged,
 * since nobody making the request can bring that about.
 */
export async function passesHumanCheck(
  env: ApiBindings,
  challenge: HumanCheckChallenge,
  token: string,
  remoteIp: string | undefined,
): Promise<boolean> {
  const configured = keys(env);
  if (!configured) return true;
  const unavailable = (reason: string) => {
    console.error("human_check_unavailable", {
      activityId: challenge.cData,
      reason,
    });
    return true;
  };
  const form = new FormData();
  form.set("secret", configured.secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  let outcome: SiteverifyOutcome;
  try {
    let response: Response;
    try {
      response = await fetch(SITEVERIFY_URL, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } catch {
      return unavailable(controller.signal.aborted ? "timeout" : "network");
    }
    if (!response.ok) return unavailable(`http_${response.status}`);
    try {
      outcome = (await response.json()) as SiteverifyOutcome;
    } catch {
      return unavailable("invalid_response");
    }
  } finally {
    clearTimeout(timeout);
  }
  if (outcome.success !== true) {
    const codes = Array.isArray(outcome["error-codes"])
      ? outcome["error-codes"].filter(
          (code): code is string => typeof code === "string",
        )
      : [];
    const fault = codes.find((code) => OUR_FAULT.has(code));
    return fault ? unavailable(fault) : false;
  }
  // A test key's dummy token carries none of what is checked below.
  if (isTestSiteKey(configured.siteKey)) return true;
  const host = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).hostname : null;
  return (
    outcome.hostname === host &&
    outcome.action === challenge.action &&
    outcome.cdata === challenge.cData
  );
}
