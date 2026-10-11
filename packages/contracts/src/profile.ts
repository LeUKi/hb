import { z } from "zod";

export type AccountTier = "standard" | "lite";

/** Public identity only. Contact information belongs to the private account response. */
export type PublicUserProfile = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  accountTier: AccountTier | null;
};

export function normalizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

const connectEmailSchema = z.email().max(320);

export function normalizeConnectEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  const parsed = connectEmailSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : null;
}
