import type { ApiBindings } from "../env";

// Where Durable Objects are created (docs/d1-apac-migration.md). Both
// settings stay empty until D1 moves. DO_LOCATION_HINT places every object
// created from then on near D1; DO_NAME_PREFIX gives the long-lived objects
// that keep nothing in DO storage new names, so they are created afresh at
// the hinted place and the old ones go unused. A 红包's own object keeps its
// name (the 红包 id): it holds deadline and draw alarms, and stays where it
// is until the 红包 ends.

const HINTS: readonly DurableObjectLocationHint[] = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
];

export function isLocationHint(
  value: string,
): value is DurableObjectLocationHint {
  return (HINTS as readonly string[]).includes(value);
}

function hintOf(env: ApiBindings) {
  const value = env.DO_LOCATION_HINT?.trim() ?? "";
  return isLocationHint(value) ? value : undefined;
}

const prefixOf = (env: ApiBindings) => env.DO_NAME_PREFIX?.trim() ?? "";

/** Names of the objects that are not a 红包's own. */
export const objectNames = {
  /** One per author: new 红包 are created one at a time. */
  creation: (env: ApiBindings, authorId: string) =>
    `${prefixOf(env)}activity-create:${authorId}`,
  /** One per person: their 口令 lookups on the start page. */
  globalRedemption: (env: ApiBindings, userId: string) =>
    `${prefixOf(env)}global-redemption:${userId}`,
  /** The one the cron wakes for every maintenance run. */
  maintenance: (env: ApiBindings) => `${prefixOf(env)}maintenance:v1`,
  /** One per merchant Client ID: its payments go out one cycle at a time. */
  merchant: (env: ApiBindings, clientId: string) =>
    `${prefixOf(env)}${clientId}`,
};

function stub<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  hint: DurableObjectLocationHint | undefined,
) {
  const id = namespace.idFromName(name);
  return hint ? namespace.get(id, { locationHint: hint }) : namespace.get(id);
}

/** A 红包's own object. */
export const activityObject = (env: ApiBindings, activityId: string) =>
  stub(env.ACTIVITY_DO, activityId, hintOf(env));

export const creationObject = (env: ApiBindings, authorId: string) =>
  stub(env.ACTIVITY_DO, objectNames.creation(env, authorId), hintOf(env));

export const globalRedemptionObject = (env: ApiBindings, userId: string) =>
  stub(env.ACTIVITY_DO, objectNames.globalRedemption(env, userId), hintOf(env));

export const maintenanceObject = (env: ApiBindings) =>
  stub(env.ACTIVITY_DO, objectNames.maintenance(env), hintOf(env));

export const merchantObject = (env: ApiBindings, clientId: string) =>
  stub(env.MERCHANT_DO, objectNames.merchant(env, clientId), hintOf(env));
