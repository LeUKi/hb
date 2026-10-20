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

/** A request that does not hold together: each field's problem with it. */
export class RequestIssuesError extends ActivityError {
  constructor(
    public readonly issues: { path: string; message: string }[],
    message = "请检查请求内容",
  ) {
    super(400, "INVALID_REQUEST", message);
  }
}

/** Too many at once: comes back with Retry-After (app.ts onError). */
export class RateLimitedError extends ActivityError {
  constructor(
    public readonly retryAfter: number,
    message = "请求太频繁了，请稍后再试",
  ) {
    super(429, "RATE_LIMITED", message);
  }
}
