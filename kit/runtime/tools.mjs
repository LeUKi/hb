// judge()'s second argument: what is particular to 红包, nothing Node or
// the Web standards already give (docs/programmable-hongbao-design.md §4.5).
import { personalCode, sameCode, timeWindow, totp } from "./codes.mjs";
import { evenAmount, formatAmount, luckyAmount } from "./money.mjs";
import { createRandom } from "./random.mjs";
import { normalizeText } from "./text.mjs";
import { timeParts } from "./time.mjs";

/**
 * Tools for one submission. `seeds` are this submission's and this
 * person's (seeds.mjs); `next` is what Math.random() becomes meanwhile.
 */
export function createTools(submission, seeds) {
  const random = createRandom(seeds.submission);
  const userRandom = createRandom(seeds.user);
  const { hongbao, share, now } = submission;
  const tools = Object.freeze({
    random: random.api,
    userRandom: userRandom.api,
    money: Object.freeze({
      even: () => evenAmount(hongbao, share),
      lucky: (kind = "double") =>
        luckyAmount(kind, hongbao, share, random.fill),
      format: (amount) => formatAmount(amount),
    }),
    code: Object.freeze({
      personal: (key, parts, length) => personalCode(key, parts, length),
      totp: (secret, options = {}) => totp(secret, { ...options, now }),
      window: (seconds) => timeWindow(now, seconds),
      same: (input, code) => sameCode(input, code),
    }),
    text: Object.freeze({ normalize: (text) => normalizeText(text) }),
    time: Object.freeze({ parts: (timeZone) => timeParts(now, timeZone) }),
  });
  return { tools, next: random.api.next };
}
