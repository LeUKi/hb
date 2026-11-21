/**
 * A request that got no answer, in plain words (07 §1): fetch rejects with
 * the browser's own text then — "Load failed" on Safari, "Failed to fetch"
 * on Chrome — which notices that show a failure's message printed as it
 * came. The request may have arrived all the same, so it says the outcome
 * is not known (sweep 2026-11-21).
 */
export const noAnswer = "网络出了问题，没有收到红包站的回答，结果还没确认。";

/**
 * fetch, its no-answer TypeError reworded. It stays a TypeError, so
 * whatever tells a missing answer from a refusal (refused, failureText in
 * lib/activities.ts) still does; an abort is left as it is.
 */
export const answered: typeof fetch = (input, init) =>
  fetch(input, init).catch((error: unknown) => {
    if (error instanceof TypeError)
      throw new TypeError(noAnswer, { cause: error });
    throw error;
  });
