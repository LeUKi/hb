import { normalizeActivityUuid } from "@hb/contracts";
import { activityShareUrl } from "../src/lib/emoji-links";
import { gallerySamples } from "./framework-fixtures";

// Named local fixtures need UUID aliases for the same Ecoji codec as the app.
// These aliases resolve only within the prototype; saved activities use their IDs.
const fixtureIds = [
  ...new Set(gallerySamples.map((activity) => activity.id)),
].filter((id) => !normalizeActivityUuid(id));
const fixtureUuids = new Map(
  fixtureIds.map((id, index) => [
    id,
    `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  ]),
);
const uuidFixtures = new Map([...fixtureUuids].map(([id, uuid]) => [uuid, id]));

export function resolvePrototypeActivityId(id: string): string {
  const uuid = normalizeActivityUuid(id);
  return uuid ? (uuidFixtures.get(uuid) ?? uuid) : id;
}

export function prototypeActivityUuid(id: string) {
  return normalizeActivityUuid(id) ?? fixtureUuids.get(id) ?? id;
}

export function buildPrototypeActivityShareUrl(id: string, origin: string) {
  return activityShareUrl(prototypeActivityUuid(id), origin);
}
