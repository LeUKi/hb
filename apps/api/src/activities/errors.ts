import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ActivityError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ActivityError";
  }
}

export function activityNotFound(): never {
  throw new ActivityError(404, "ACTIVITY_NOT_FOUND", "未找到活动");
}

export function activityConflict(message?: string): never {
  throw new ActivityError(
    409,
    message === undefined ? "ACTIVITY_VERSION_CONFLICT" : "ACTIVITY_CONFLICT",
    message ?? "活动已更新，请刷新后重试",
  );
}

export function invalidActivity(message: string): never {
  throw new ActivityError(400, "INVALID_ACTIVITY", message);
}
