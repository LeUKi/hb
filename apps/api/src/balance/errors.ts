import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ActivityError } from "../activities/errors";

/** 🐟额's errors travel as every other API error (app.ts onError). */
export function balanceError(
  status: ContentfulStatusCode,
  code: string,
  message: string,
): never {
  throw new ActivityError(status, code, message);
}
