// Built in place of apps/web/src/lib/activities.ts (vite.config.ts): its
// requests are 红包站's own; the mini app's parts only test errors against
// this one. No readResponse here, on purpose: a lib module that reads
// 红包站 with it has made its fetch by then, so the build stops at it
// (MISSING_EXPORT) until it gets its own file here, as lib/notices.ts and
// lib/viewers.ts did (sweep 2026-11-21).
export class ActivityRequestError extends Error {}
