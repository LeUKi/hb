// Where tools.random and tools.userRandom come from. Each 红包 has a secret
// seed made at opening; only its commitment is shown until the end. The
// sandbox is only ever given the two seeds below, never the secret, so no
// code can work out what anyone else will draw. Lines joined by "\n", as in
// the 开奖证明, so each can be checked with printf … | sha256sum.
import { sha256Text } from "./hash.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

function checked(secret) {
  if (!HEX64.test(secret)) throw new Error("Invalid secret");
  return secret;
}

/** Published at opening; the secret, published at the end, must match it. */
export function seedCommitment(hongbaoId, secret) {
  return sha256Text(
    ["hb.lafi.sh/judge/v1", hongbaoId, checked(secret)].join("\n"),
  );
}

/** tools.random: this person's attempts-th submission. */
export function submissionSeed(hongbaoId, secret, userId, attempts) {
  return sha256Text(
    [
      "hb.lafi.sh/judge/v1/random",
      hongbaoId,
      checked(secret),
      String(userId),
      String(attempts),
    ].join("\n"),
  );
}

/** tools.userRandom: the same for all of this person's submissions. */
export function userSeed(hongbaoId, secret, userId) {
  return sha256Text(
    [
      "hb.lafi.sh/judge/v1/user-random",
      hongbaoId,
      checked(secret),
      String(userId),
    ].join("\n"),
  );
}
