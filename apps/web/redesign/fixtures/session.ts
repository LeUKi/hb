export type IdentityKind = "guest" | "standard" | "admin" | "fresh";

export type SessionUser = {
  id: string;
  displayName: string;
  username: string;
  isAdmin: boolean;
  /** A new account: no 红包 sent or taken, no merchant (empty states). */
  fresh?: boolean;
};

/** Who the demo accounts are; some 红包 already have their claim. */
export const demoViewerName = "林间";

const users: Record<Exclude<IdentityKind, "guest">, SessionUser> = {
  standard: {
    id: "demo-standard",
    displayName: demoViewerName,
    username: "linjian",
    isAdmin: false,
  },
  admin: {
    id: "demo-admin",
    displayName: demoViewerName,
    username: "linjian",
    isAdmin: true,
  },
  fresh: {
    id: "demo-fresh",
    displayName: "新来的",
    username: "xinlaide",
    isAdmin: false,
    fresh: true,
  },
};

export const identityKinds: IdentityKind[] = [
  "guest",
  "standard",
  "admin",
  "fresh",
];

export function isIdentityKind(value: unknown): value is IdentityKind {
  return identityKinds.includes(value as IdentityKind);
}

export function sessionFor(kind: IdentityKind): SessionUser | null {
  return kind === "guest" || !isIdentityKind(kind) ? null : users[kind];
}

export const identityLabels: Record<IdentityKind, string> = {
  guest: "游客",
  standard: "普通",
  admin: "管理员",
  fresh: "新账号",
};

/** Simulated identity check latency used by the boot loader. */
export function identityLatency(slow: boolean) {
  return slow ? 900 : 220;
}

/**
 * What /me shows beyond the session: the site's own account ID and the
 * Connect e-mail (production reads it from /api/me/profile). Fake values.
 */
export const demoProfile = {
  accountId: "0f8e6d1c-3b2a-4c5d-9e8f-7a6b5c4d3e2f",
  email: "linjian@example.com",
};

export function profileOf(user: SessionUser) {
  return user.fresh
    ? {
        accountId: "5c1e9a3b-7d2f-4e8a-b6c0-1f2e3d4c5b6a",
        email: `${user.username}@example.com`,
      }
    : demoProfile;
}
