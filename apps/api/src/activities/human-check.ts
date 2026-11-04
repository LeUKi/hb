import type { HumanCheckChallenge, HumanCheckMethod } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { ActivityError } from "./errors";
import type { ActivityRow } from "./storage";

// 领取前人机验证: a 红包 whose author turned it on asks each claim or sign-up
// for a token first, from Cap (docs/cap-design.md) or Cloudflare Turnstile,
// as the author chose. The API route checks the token before the 红包's
// Durable Object (whose writes queue one by one) sees the request; the
// Durable Object, which knows when a claim would really go ahead, asks for
// one (HUMAN_CHECK_REQUIRED) only then.

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

/**
 * Cap: where pages reach it, the service bound for siteverify (CAP), this
 * site's key there, and its secret.
 */
export function capKeys(env: ApiBindings) {
  const origin = env.CAP_ORIGIN?.trim().replace(/\/+$/, "") ?? "";
  const siteKey = env.CAP_SITE_KEY?.trim() ?? "";
  const secret = env.CAP_SECRET_KEY?.trim() ?? "";
  return env.CAP && origin && siteKey && secret
    ? { service: env.CAP, origin, siteKey, secret }
    : null;
}

/** Whether this environment can ask for this kind of human check. */
export function humanCheckAvailable(
  env: ApiBindings,
  method: HumanCheckMethod,
) {
  return (method === "cap" ? capKeys(env) : keys(env)) !== null;
}

/**
 * The human check a stored configuration asks for, or null. One turned on
 * before there was a choice is Turnstile.
 */
export function humanCheckMethodOf(config: {
  humanCheck?: unknown;
  humanCheckMethod?: unknown;
}): HumanCheckMethod | null {
  if (config.humanCheck !== true) return null;
  return config.humanCheckMethod === "cap" ? "cap" : "turnstile";
}

export function humanCheckEnabled(activity: Pick<ActivityRow, "config">) {
  return humanCheckMethodOf(JSON.parse(activity.config)) !== null;
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
  const method = humanCheckMethodOf(JSON.parse(activity.config));
  if (!method) return null;
  const cap = method === "cap" ? capKeys(env) : null;
  const configured = method === "cap" ? cap : keys(env);
  if (!configured) {
    console.error("human_check_not_configured", {
      activityId: activity.id,
      method,
    });
    return null;
  }
  const action = actionOf(activity);
  return cap
    ? {
        method: "cap",
        siteKey: cap.siteKey,
        action,
        cData: activity.id,
        // The page asks Cap itself, its challenge bound to this 红包 and action.
        endpoint: `${cap.origin}/${encodeURIComponent(cap.siteKey)}/scope/${action}:${activity.id}/`,
      }
    : { siteKey: configured.siteKey, action, cData: activity.id };
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
  if (challenge.method === "cap") return passesCap(env, challenge, token);
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

/**
 * passesHumanCheck for Cap: its siteverify, through the service binding.
 * The token must be unused and for this 红包 and action (its scope).
 */
function passesCap(
  env: ApiBindings,
  challenge: HumanCheckChallenge,
  token: string,
): Promise<boolean> {
  return verifyCapToken(
    env,
    token,
    `${challenge.action}:${challenge.cData}`,
    challenge.cData,
  );
}

/**
 * Where a page asks Cap for a challenge bound to `scope` (红包 claims and
 * 打赏 links alike), or null when Cap is not set up here.
 */
export function capEndpoint(env: ApiBindings, scope: string) {
  const cap = capKeys(env);
  return cap
    ? `${cap.origin}/${encodeURIComponent(cap.siteKey)}/scope/${scope}/`
    : null;
}

/**
 * Whether a Cap token is unused and was given for `scope`. When Cap itself
 * cannot answer (or is not set up here) it passes and is logged: nobody
 * making the request can bring that about.
 */
export async function verifyCapToken(
  env: ApiBindings,
  token: string,
  scope: string,
  logId: string,
): Promise<boolean> {
  const configured = capKeys(env);
  if (!configured) return true;
  const unavailable = (reason: string) => {
    console.error("human_check_unavailable", {
      activityId: logId,
      method: "cap",
      reason,
    });
    return true;
  };
  let outcome: { success?: unknown; scope?: unknown };
  try {
    const response = await configured.service.fetch(
      `https://cap.internal/${encodeURIComponent(configured.siteKey)}/siteverify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: configured.secret, response: token }),
        signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      },
    );
    // A wrong secret (403) or site (404) is this side's fault.
    if (!response.ok) return unavailable(`http_${response.status}`);
    outcome = await response.json();
  } catch (error) {
    return unavailable(
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "network",
    );
  }
  return outcome.success === true && outcome.scope === scope;
}
