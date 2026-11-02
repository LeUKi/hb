import type { ApiBindings } from "../env";

export type PlatformControls = {
  version: number;
  allowRealOpen: boolean;
  allowRealClaim: boolean;
  allowRealSend: boolean;
};

export async function readPlatformControls(
  env: ApiBindings,
): Promise<PlatformControls> {
  const row = await env.DB.prepare(
    "SELECT version,allow_real_open,allow_real_claim,allow_real_send FROM platform_controls WHERE id='global'",
  ).first<{
    version: number;
    allow_real_open: number;
    allow_real_claim: number;
    allow_real_send: number;
  }>();
  return {
    version: row?.version ?? 0,
    allowRealOpen: row?.allow_real_open === 1,
    allowRealClaim: row?.allow_real_claim === 1,
    allowRealSend: row?.allow_real_send === 1,
  };
}

// Missing environment values never grant public simulation or live payment access.
export function isLocalSimulation(env: ApiBindings) {
  return env.APP_ENV === "local";
}

function live(env: ApiBindings) {
  return env.APP_ENV === "production" && env.LDC_NETWORK_MODE === "live";
}

/**
 * Stage's 🐟额红包 open and are claimed (2026-11-02, the user, to try the
 * forum's mini app for real; docs/mini-app-design.md §7): 🐟额 is this
 * site's own ledger and never reaches Credit, so nothing real moves. Every
 * LDC 红包 on Stage stays shut, as everything does but production.
 */
export function stageBalanceHongbao(
  env: ApiBindings,
  funding: string | null | undefined,
) {
  return env.APP_ENV === "staging" && funding === "balance";
}

/** Real Credit calls of any kind (🐟额 转入 too): production, live network. */
export function reachesCredit(env: ApiBindings) {
  return live(env);
}
export function allowsRealOpening(
  env: ApiBindings,
  controls: PlatformControls,
) {
  return (
    live(env) && env.LDC_STOP_NEW_OPENINGS !== "true" && controls.allowRealOpen
  );
}
export function allowsRealClaim(env: ApiBindings, controls: PlatformControls) {
  return (
    live(env) && env.LDC_STOP_NEW_CLAIMS !== "true" && controls.allowRealClaim
  );
}
export function allowsRealSending(
  env: ApiBindings,
  controls: PlatformControls,
) {
  return live(env) && env.LDC_STOP_SENDS !== "true" && controls.allowRealSend;
}
