import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";

export async function hasOfficialConnect(env: ApiBindings, userId: string) {
  const user = await env.DB.prepare(
    "SELECT official_connect_verified FROM users WHERE id=? AND active=1",
  )
    .bind(userId)
    .first<{ official_connect_verified: number }>();
  return user?.official_connect_verified === 1;
}

export async function requireOfficialConnect(env: ApiBindings, userId: string) {
  if (!(await hasOfficialConnect(env, userId))) {
    throw new ActivityError(
      403,
      "OFFICIAL_CONNECT_REQUIRED",
      "青春版账号需先通过官方 Connect 登录，才能使用 LDC 功能",
    );
  }
}
