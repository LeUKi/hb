import type { ClaimActivityInput, ParticipationMode } from "@hb/contracts";
import type { ApiBindings } from "../env";
import type { ActivityAttempt } from "../runtime/attempt-cooldown";
import { digestPassword } from "../security/crypto";
import { ActivityError } from "./errors";
import type { ActivityRow } from "./storage";

export function assertParticipationMode(
  activity: Pick<ActivityRow, "participationMode">,
  mode: ParticipationMode,
) {
  if (activity.participationMode !== mode)
    throw new ActivityError(
      409,
      "PARTICIPATION_MODE_MISMATCH",
      "红包的参与方式已更新，请刷新红包页后再参与",
    );
}

/** Password request fingerprints are unchanged, including legacy clients. */
export async function participationRequest(
  env: ApiBindings,
  activityId: string,
  input: ClaimActivityInput,
  purpose: "claim" | "register",
): Promise<{
  mode: ParticipationMode;
  fingerprint: string;
  passwordDigest: string | null;
  continuation: ActivityAttempt | undefined;
}> {
  if (!("password" in input))
    return {
      mode: "direct",
      fingerprint: await digestPassword(
        `direct-${purpose}-request:${activityId}`,
        env.PASSWORD_DIGEST_KEY,
      ),
      passwordDigest: null,
      continuation: undefined,
    };
  const [fingerprint, passwordDigest] = await Promise.all([
    digestPassword(
      `${purpose}-request:${activityId}:${input.password}`,
      env.PASSWORD_DIGEST_KEY,
    ),
    digestPassword(input.password, env.PASSWORD_DIGEST_KEY),
  ]);
  return {
    mode: "password",
    fingerprint,
    passwordDigest,
    continuation: {
      activityId,
      submissionId: input.submissionId,
      passwordDigest,
      discoveryId: input.discoveryId,
    },
  };
}
