import type { ClaimRosterSnapshot } from "./claim-rosters";
import type { DrawRostersSnapshot } from "./draw-rosters";
import type { RandomRosterCase } from "./fixtures";
import type { WorkbenchStoresSnapshot } from "./pages/workbench-store";
import type {
  Activity,
  ActivityViewStateOverrides,
  Identity,
  Participation,
  ParticipationResult,
  Scenario,
} from "./types";

export type ActivityWindowSnapshot = {
  version: 2;
  createdAt: number;
  activityId: string;
  identity: Identity;
  active?: Activity;
  activityScenarios: Record<string, Scenario>;
  records: Record<string, Participation>;
  results: Record<string, ParticipationResult>;
  activityStates: Record<string, ActivityViewStateOverrides>;
  solved: Record<string, string[]>;
  fuzzy: boolean;
  showRecipients: boolean;
  rosterCase: RandomRosterCase;
  stores?: WorkbenchStoresSnapshot;
  claims?: ClaimRosterSnapshot;
  draws?: DrawRostersSnapshot;
};

export type ActivityWindowBootstrapResult =
  | { ok: true; snapshot: ActivityWindowSnapshot }
  | { ok: false; retry: () => void };

type WireMessage =
  | { type: "ready"; token: string }
  | { type: "snapshot"; token: string; snapshot: ActivityWindowSnapshot }
  | { type: "received"; token: string };

const CHANNEL_PREFIX = "hb-prototype-activity-window-v2";
const VIEW_PARAM = "view";
const TIMEOUT_MS = 30_000;
let snapshotProvider: ((activityId: string) => ActivityWindowSnapshot) | null =
  null;
let bootstrappedSnapshot: ActivityWindowSnapshot | null = null;

function channelName(token: string) {
  return `${CHANNEL_PREFIX}:${token}`;
}

function createToken() {
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  return Array.from(values, (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");
}

function readHashParams(hash = window.location.hash) {
  const [, query = ""] = hash.split("?");
  return new URLSearchParams(query);
}

function setHashParam(href: string, key: string, value?: string) {
  const url = new URL(href, window.location.href);
  const [page = "activity", query = ""] = url.hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  if (value === undefined) params.delete(key);
  else params.set(key, value);
  url.hash = `${page}?${params.toString()}`;
  return url.href;
}

function removeCurrentHashParam(key: string) {
  const [page = "activity", query = ""] = window.location.hash
    .slice(1)
    .split("?");
  const params = new URLSearchParams(query);
  if (!params.has(key)) return;
  params.delete(key);
  const next = params.toString();
  history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#${page}${next ? `?${next}` : ""}`,
  );
}

export function registerActivityWindowSnapshot(
  getSnapshot: (activityId: string) => ActivityWindowSnapshot,
) {
  snapshotProvider = getSnapshot;
  return () => {
    if (snapshotProvider === getSnapshot) snapshotProvider = null;
  };
}

export function getBootstrappedActivityWindowSnapshot() {
  return bootstrappedSnapshot;
}

export function prepareActivityWindowLink(
  anchor: HTMLAnchorElement,
  activityId: string,
) {
  if (!snapshotProvider) return;
  const hrefBeforeClick = setHashParam(anchor.href, VIEW_PARAM);
  const token = createToken();
  const provided = snapshotProvider(activityId);
  const snapshot = structuredClone({
    ...provided,
    activityId,
    createdAt: Date.now(),
  });
  const channel = new BroadcastChannel(channelName(token));
  const preparedHref = setHashParam(hrefBeforeClick, VIEW_PARAM, token);
  let done = false;
  const restoreHref = () => {
    if (anchor.href === preparedHref) anchor.href = hrefBeforeClick;
  };
  const close = () => {
    restoreHref();
    done = true;
    channel.close();
  };
  const timeout = window.setTimeout(close, TIMEOUT_MS);
  channel.onmessage = (event: MessageEvent<WireMessage>) => {
    if (done || event.data.token !== token) return;
    if (event.data.type === "ready")
      channel.postMessage({ type: "snapshot", token, snapshot });
    if (event.data.type === "received") {
      window.clearTimeout(timeout);
      close();
    }
  };
  anchor.href = preparedHref;
}

export function bootstrapActivityWindow(): Promise<ActivityWindowBootstrapResult | null> {
  const token = readHashParams().get(VIEW_PARAM);
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(channelName(token));
    const timeout = window.setTimeout(() => {
      channel.close();
      resolve({ ok: false, retry: () => window.location.reload() });
    }, TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent<WireMessage>) => {
      if (event.data.type !== "snapshot" || event.data.token !== token) return;
      window.clearTimeout(timeout);
      channel.postMessage({ type: "received", token });
      channel.close();
      if (
        event.data.snapshot.version !== 2 ||
        (event.data.snapshot.active &&
          event.data.snapshot.active.type !== "ldc" &&
          event.data.snapshot.active.type !== "draw") ||
        Date.now() - event.data.snapshot.createdAt > TIMEOUT_MS
      )
        resolve({ ok: false, retry: () => window.location.reload() });
      else {
        removeCurrentHashParam(VIEW_PARAM);
        bootstrappedSnapshot = event.data.snapshot;
        resolve({ ok: true, snapshot: event.data.snapshot });
      }
    };
    channel.postMessage({ type: "ready", token });
  });
}
