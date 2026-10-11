import type { ApiBindings } from "../env";

export function isAdministrator(
  env: ApiBindings,
  provider: string,
  externalId: string,
) {
  const ids = env.ADMIN_LINUX_DO_IDS?.split(",").map((id) => id.trim());
  return Boolean(
    provider === "linux_do" &&
      ids?.length &&
      ids.every((id) => /^[1-9]\d{0,18}$/.test(id)) &&
      ids.includes(externalId),
  );
}
