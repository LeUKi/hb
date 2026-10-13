import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  Gift,
  Home,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  UserRound,
  X,
} from "lucide-react";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  lazy,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ActionButton,
  type ActionFeedback,
  ActionFeedbackLabel,
  useActionFeedback,
} from "../src/components/ui/action-feedback";
import { resolveEmojiPath } from "../src/lib/emoji-links";
import {
  classifyHomeEntry,
  HOME_ENTRY_HELP,
  HOME_ENTRY_LABEL,
} from "../src/lib/home-entry";
import {
  buildPrototypeActivityShareUrl,
  resolvePrototypeActivityId,
} from "./activity-links";
import {
  getActivityPublicMetadata,
  isActivityDeadlineReached,
  prototypeStartedAt,
} from "./activity-metadata";
import { projectActivityNotes } from "./activity-notes";
import { buildActivityShareText } from "./activity-share";
import {
  getBootstrappedActivityWindowSnapshot,
  registerActivityWindowSnapshot,
} from "./activity-window";
import { markAttemptSuccessful, recordAttempt } from "./attempt-statistics";
import {
  exportClaimRosterSnapshot,
  publicClaimRoster,
  recordInstantClaim,
} from "./claim-rosters";
import { ActionMenu } from "./components/action-menu";
import { publicQuantityLabel } from "./components/activity-card";
import {
  ActivityCountdown,
  useDeadlineExpired,
} from "./components/activity-countdown";
import { PrototypeActivityImageShare } from "./components/activity-image-share";
import {
  ActivityNoteSection,
  ActivityNotes,
} from "./components/activity-notes";
import { ActivityRows } from "./components/activity-rows";
import { ActivitySelectionDialog } from "./components/activity-selection-dialog";
import { CompactIconButton } from "./components/compact-icon-button";
import { Help } from "./components/context-help";
import { Envelope } from "./components/envelope";
import { Avatar, UserIdentity } from "./components/identity";
import {
  ListPanel,
  Pagination,
  SegmentedControl,
  usePagination,
} from "./components/list-controls";
import { inspectPassword, PasswordInput } from "./components/password-input";
import { PasswordList } from "./components/password-list";
import { PortalTargetProvider } from "./components/portal-target";
import { PublicRoster } from "./components/public-roster";
import {
  allowPrototypeNavigation,
  type HistoryOrigin,
  historyEntryIndex,
  isPrototypeHistoryRestoring,
  PROTOTYPE_HISTORY_CHANGED,
  pushPrototypeHistory,
  replacePrototypeHistory,
} from "./navigation-guard";
import "./components/public-square-dialog.css";
import {
  RedemptionAction,
  RedemptionRouteFrame,
  type RedemptionTransition,
  RedemptionTransitionProvider,
} from "./components/redemption-transition";
import {
  exportDrawRostersSnapshot,
  getDrawRoster,
  recordDrawRegistration,
  resolveDrawParticipation,
  setDrawScenario,
  useDrawRoster,
} from "./draw-rosters";
import {
  envelopeImagePresentation,
  envelopePresentation,
} from "./envelope-presentation";
import {
  activities,
  createParticipationSeed,
  drawWinnerExamples,
  getSampleResult,
  longNote,
  type RandomRosterCase,
  randomRosterCaseLabels,
} from "./fixtures";
import { gallerySamples } from "./framework-fixtures";
import {
  endWorkbenchActivity,
  exportWorkbenchStoresSnapshot,
  findPublishedWorkbenchActivity,
  findWorkbenchActivity,
  listPublishedWorkbenchActivities,
  toPrototypeActivity,
  useWorkbenchStore,
} from "./pages/workbench-store";
import { projectPasswordAccess } from "./password-access";
import { publicActivityStatus } from "./public-activity-status";
import { formatFullDateTime, ShortTime, useClockSelector } from "./time";
import { normalizePrototypeTopicLink } from "./topic-link";
import type {
  Activity,
  ActivityViewState,
  ActivityViewStateOverrides,
  Identity,
  Page,
  Participation,
  ParticipationResult,
  Scenario,
} from "./types";
import {
  activityLifecycleLabels,
  activityStatusSentence,
  effectiveDrawProgress,
  fuzzyQuantityLabel,
  projectActivityViewState,
  scenarioViewState,
} from "./view-state";

const Workbench = lazy(() =>
  import("./pages/workbench").then((module) => ({
    default: function WorkbenchPage({
      page,
      ...props
    }: {
      page: Page;
      navigate: (
        page: Page,
        options?: { activityId?: string; editId?: string },
      ) => boolean;
      identity: Identity;
      onIdentityChange?: (identity: Identity) => void;
      editId?: string;
      activityId?: string;
      listState?: "ready" | "empty" | "loading" | "error";
      onRetry?: () => void;
    }) {
      const Component =
        page === "create"
          ? module.CreatePage
          : page === "manage"
            ? module.ManagePage
            : page === "merchant"
              ? module.MerchantPage
              : page === "payment"
                ? module.PaymentPage
                : page === "statistics"
                  ? module.AttemptStatisticsPage
                  : module.AccountPage;
      return <Component {...props} />;
    },
  })),
);
const AdminPrototype = lazy(() =>
  import("./pages/admin").then((module) => ({
    default: module.AdminPrototype,
  })),
);
const SvgGallery = lazy(() =>
  import("./pages/svg-gallery").then((module) => ({
    default: module.SvgGallery,
  })),
);
const first = activities[0] as Activity;
const pages = new Set<Page>([
  "home",
  "activity",
  "participations",
  "create",
  "manage",
  "account",
  "merchant",
  "payment",
  "statistics",
  "admin",
  "svg-gallery",
]);
function pageFromHash() {
  const emojiId = resolveEmojiPath(window.location.pathname);
  if (emojiId)
    replacePrototypeHistory(
      window.history.state,
      `/#activity?sample=${encodeURIComponent(resolvePrototypeActivityId(emojiId))}`,
    );
  clearRetiredRewardFilters();
  normalizePublicSquareHash();
  const value = window.location.hash.slice(1).split("?")[0] as Page;
  return pages.has(value) ? value : "home";
}
function clearRetiredRewardFilters() {
  const [page = "home", query = ""] = window.location.hash.slice(1).split("?");
  if (!["home", "square", "manage", "participations"].includes(page)) return;
  const params = new URLSearchParams(query);
  let changed = false;
  for (const key of ["rewardType", "reward", "type", "rewardFilter"])
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  if (!changed) return;
  params.delete("cursor");
  params.delete("page");
  const search = params.toString();
  replacePrototypeHistory(null, `#${page}${search ? `?${search}` : ""}`);
}
type PublicSquareState = {
  open: boolean;
  status: "all" | "active" | "ended";
  page: number;
  scrollTop: number;
};
function publicSquareHash(state: Pick<PublicSquareState, "status" | "page">) {
  const query = new URLSearchParams({ dialog: "square" });
  if (state.status !== "all") query.set("status", state.status);
  if (state.page > 1) query.set("page", String(state.page));
  return `#home?${query}`;
}
function normalizePublicSquareHash() {
  const [page = "home", query = ""] = window.location.hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  const legacy = page === "square";
  if (!legacy && (page !== "home" || params.get("dialog") !== "square")) return;
  const metadata = window.history.state?.prototypePublicSquare;
  if (!legacy && metadata?.version === 1) return;
  const status = params.get("status");
  const rawPage = Number(params.get("page"));
  const state = {
    status: status === "active" || status === "ended" ? status : "all",
    page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
  } as const;
  // Direct and legacy links get a home entry so one browser Back closes the
  // native modal. Reload retains the already-created modal entry.
  replacePrototypeHistory(null, "#home");
  pushPrototypeHistory(
    { prototypePublicSquare: { version: 1, scrollTop: 0 } },
    publicSquareHash(state),
  );
}
function publicSquareFromHash(): PublicSquareState {
  const [page = "home", query = ""] = window.location.hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  const status = params.get("status");
  const rawPage = Number(params.get("page"));
  const scrollTop = window.history.state?.prototypePublicSquare?.scrollTop;
  return {
    open: page === "home" && params.get("dialog") === "square",
    status: status === "active" || status === "ended" ? status : "all",
    page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
    scrollTop:
      typeof scrollTop === "number" && Number.isFinite(scrollTop)
        ? Math.max(0, scrollTop)
        : 0,
  };
}
function activityFromHash(
  identity: Identity = "standard",
  bootstrappedActivity?: Activity,
) {
  const rawSample = new URLSearchParams(
    window.location.hash.split("?")[1] ?? "",
  ).get("sample");
  const sample = rawSample ? resolvePrototypeActivityId(rawSample) : null;
  if (sample && bootstrappedActivity?.id === sample)
    return bootstrappedActivity;
  const managed = sample ? findWorkbenchActivity(identity, sample) : undefined;
  return (
    (managed ? toPrototypeActivity(managed) : undefined) ??
    (sample ? findPublishedWorkbenchActivity(sample) : undefined) ??
    gallerySamples.find((activity) => activity.id === sample) ??
    (sample ? undefined : first)
  );
}
function workbenchRoute() {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return {
    editId: query.get("edit") ?? undefined,
    activityId: query.get("activity") ?? undefined,
  };
}
function activityHash(activity: Activity) {
  return `#activity?sample=${encodeURIComponent(activity.id)}`;
}
const scenarioOptions: [Scenario, string][] = [
  ["ready", "即时 LDC"],
  ["random", "即时随机 · 拼手气"],
  ["random-ended", "拼手气 · 已结束"],
  ["pending", "等待发放"],
  ["registered", "已报名"],
  ["drawing", "正在开奖"],
  ["draw-no-winners", "已公布结果 · 无人中奖"],
  ["draw-empty", "零报名结束"],
  ["won", "已中奖"],
  ["not-won", "未中奖"],
  ["ended", "活动结束"],
  ["notes-drawing-ended", "说明 · 已结束，正在开奖"],
  ["long", "长说明"],
  ["multiple", "多口令"],
  ["slow", "慢请求"],
  ["failure", "请求结果待确认"],
];

export function App() {
  const [bootstrap] = useState(getBootstrappedActivityWindowSnapshot);
  const initialIdentity = bootstrap?.identity ?? "standard";
  const [page, setPage] = useState<Page>(pageFromHash);
  const [publicSquare, setPublicSquare] = useState(publicSquareFromHash);
  const publicSquareEntry = useRef<HTMLButtonElement>(null);
  const lastReadHash = useRef(window.location.hash);
  const lastReadIndex = useRef(historyEntryIndex());
  const [identity, setIdentity] = useState<Identity>(initialIdentity);
  const [scenario, setScenario] = useState<Scenario>("ready");
  const [active, setActive] = useState<Activity>(
    () => bootstrap?.active ?? activityFromHash(initialIdentity) ?? first,
  );
  const [missingActivity, setMissingActivity] = useState(
    () => !(bootstrap?.active ?? activityFromHash(initialIdentity)),
  );
  const [records, setRecords] = useState<Record<string, Participation>>(
    () =>
      bootstrap?.records ?? createParticipationSeed(initialIdentity).records,
  );
  const managed = useWorkbenchStore(identity);
  const availableActivities = [
    ...gallerySamples,
    ...(identity === "guest"
      ? []
      : managed.activities.map(toPrototypeActivity)),
  ];
  // Retain a viewer's participation in published activities owned by another
  // local identity without including that identity's private author records.
  for (const [id, participation] of Object.entries(records)) {
    if (
      participation === "none" ||
      availableActivities.some((item) => item.id === id)
    )
      continue;
    const published = findPublishedWorkbenchActivity(id);
    if (published) availableActivities.push(published);
  }
  // Refresh activity projections only at deadline boundaries, not every second.
  useClockSelector((now) =>
    availableActivities
      .map((activity) => (isActivityDeadlineReached(activity, now) ? "1" : "0"))
      .join(""),
  );
  const [password, setPassword] = useState("");
  const [matches, setMatches] = useState<{
    items: Activity[];
    submitted: string;
    revision: number;
  } | null>(null);
  const [locatorMatches, setLocatorMatches] = useState<{
    items: Activity[];
    revision: number;
  } | null>(null);
  const [autoClaim, setAutoClaim] = useState<{
    id: number;
    activity: Activity;
    submitted: string;
    identity: Identity;
  } | null>(null);
  const consumedAutoClaim = useRef<number | null>(null);
  const pendingAttempt = useRef<string | null>(null);
  const operationFeedback = useActionFeedback(
    `${identity}:${active.id}:${page}`,
  );
  const message = operationFeedback.feedback?.detail ?? "";
  const setMessage = useCallback(
    (message: string) => {
      if (!message) {
        operationFeedback.clear();
        return;
      }
      operationFeedback.show(
        message.startsWith("口令不正确")
          ? "口令不正确"
          : message === "未匹配到活动。"
            ? "未匹配"
            : message.includes("暂未确认")
              ? "待确认"
              : message === "请先登录。"
                ? "请先登录"
                : "操作失败",
        message,
      );
    },
    [operationFeedback.clear, operationFeedback.show],
  );

  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [homeComposing, setHomeComposing] = useState(false);
  const homeActionRef = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState(false);
  const [results, setResults] = useState<Record<string, ParticipationResult>>(
    () =>
      bootstrap?.results ?? createParticipationSeed(initialIdentity).results,
  );
  const [activityStates, setActivityStates] = useState<
    Record<string, ActivityViewStateOverrides>
  >(
    () =>
      bootstrap?.activityStates ??
      createParticipationSeed(initialIdentity).viewStates,
  );
  const [activityScenarios, setActivityScenarios] = useState<
    Record<string, Scenario>
  >(bootstrap?.activityScenarios ?? {});
  const [solved, setSolved] = useState<Record<string, string[]>>(
    () =>
      bootstrap?.solved ??
      Object.fromEntries(
        Object.entries(createParticipationSeed(initialIdentity).results).map(
          ([id, result]) => [id, result.password ? [result.password] : []],
        ),
      ),
  );
  const privateSessions = useRef<
    Partial<
      Record<
        Identity,
        {
          records: typeof records;
          results: typeof results;
          viewStates: typeof activityStates;
          activityScenarios: typeof activityScenarios;
          solved: typeof solved;
        }
      >
    >
  >({});
  const [animateId, setAnimateId] = useState<string | null>(null);
  const [showRecipients, setShowRecipients] = useState(
    bootstrap?.showRecipients ?? true,
  );
  const [fuzzy, setFuzzy] = useState(bootstrap?.fuzzy ?? false);
  const [listState, setListState] = useState<
    "ready" | "empty" | "loading" | "error"
  >("ready");
  const [rosterCase, setRosterCase] = useState<RandomRosterCase>(
    bootstrap?.rosterCase ?? "unique",
  );
  const [workbenchContext, setWorkbenchContext] = useState(workbenchRoute);
  const windowSnapshot = useRef((activityId: string) => ({
    version: 2 as const,
    createdAt: Date.now(),
    activityId,
    identity,
    records,
    results,
    activityStates,
    activityScenarios,
    solved,
    fuzzy,
    showRecipients,
    rosterCase,
  }));
  windowSnapshot.current = (activityId) => {
    const managedTarget = findWorkbenchActivity(identity, activityId);
    const target = managedTarget
      ? toPrototypeActivity(managedTarget)
      : active.id === activityId
        ? active
        : availableActivities.find((item) => item.id === activityId);
    if (target?.type === "draw") getDrawRoster(target);
    return {
      version: 2 as const,
      createdAt: Date.now(),
      activityId,
      identity,
      active: target,
      records,
      results,
      activityStates,
      activityScenarios,
      solved,
      fuzzy,
      showRecipients,
      rosterCase,
      stores: exportWorkbenchStoresSnapshot(),
      claims: exportClaimRosterSnapshot(),
      draws: exportDrawRostersSnapshot(),
    };
  };
  useEffect(
    () => registerActivityWindowSnapshot((id) => windowSnapshot.current(id)),
    [],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(0);
  const motionOff = useReducedMotion();
  const [transition, setTransition] = useState<RedemptionTransition | null>(
    null,
  );
  const navigationSequence = useRef(0);
  const currentRoute = useRef({
    page,
    active,
    results,
    records,
    identity,
    activityStates,
  });
  currentRoute.current = {
    page,
    active,
    results,
    records,
    identity,
    activityStates,
  };
  const drawRoster = useDrawRoster(active);
  const viewState = projectActivityViewState(
    active,
    records[active.id] ?? "none",
    activityStates[active.id],
  );
  if (active.type === "draw") {
    viewState.drawProgress = effectiveDrawProgress(active, {
      ...viewState,
      drawProgress: drawRoster.progress,
    });
    if (
      viewState.lifecycle !== "archived" &&
      (drawRoster.progress === "completed" || drawRoster.progress === "empty")
    )
      viewState.lifecycle = "ended";
    const own =
      identity === "standard"
        ? resolveDrawParticipation(active, "linjian")
        : { participation: "none" as const };
    viewState.participation = own.participation;
    if (own.participation !== "won") viewState.paymentProgress = null;
  }
  const participation = viewState.participation;
  const scope = `${identity}:${active.id}`;
  const routeKey =
    page === "activity"
      ? `activity:${active.id}`
      : `${page}:${workbenchContext.editId ?? ""}:${workbenchContext.activityId ?? ""}`;

  const beginTransition = useCallback((next: Page, target?: Activity) => {
    const current = currentRoute.current;
    const element = document.querySelector(
      '.route-frame:not([inert]) [data-testid="envelope"]',
    );
    const bounds = element?.getBoundingClientRect();
    const shared = Boolean(
      bounds &&
        bounds.width > 0 &&
        bounds.bottom > 0 &&
        bounds.top < window.innerHeight,
    );
    const result =
      current.results[current.active.id] ?? getSampleResult(current.active.id);
    const own =
      current.active.type === "draw" && current.identity === "standard"
        ? resolveDrawParticipation(current.active, "linjian")
        : undefined;
    const state = projectActivityViewState(
      current.active,
      own?.participation ?? current.records[current.active.id] ?? "none",
      current.activityStates[current.active.id],
    );
    if (current.active.type === "draw") {
      state.drawProgress = getDrawRoster(current.active).progress;
      state.participation = own?.participation ?? "none";
      if (
        state.lifecycle !== "archived" &&
        (state.drawProgress === "completed" || state.drawProgress === "empty")
      )
        state.lifecycle = "ended";
    }
    if (current.identity === "guest" || current.identity === "lite")
      state.participation = "none";
    const amount = own?.rewardAmount ?? result?.rewardAmount;
    setTransition({
      id: ++navigationSequence.current,
      startedAt: Date.now(),
      from: current.page,
      to: next,
      activityId: (target ?? current.active).id,
      shared,
      closingReward:
        current.page === "activity"
          ? envelopePresentation({
              activity: current.active,
              state,
              identity: current.identity,
              amount,
            })
          : undefined,
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation and identity changes move focus; ordinary state updates must not.
  useLayoutEffect(() => {
    const main = document.getElementById("main");
    main?.focus({ preventScroll: true });
  }, [routeKey, identity]);

  useEffect(() => {
    const syncOrigin = (event: Event) => {
      const origin = (event as CustomEvent<HistoryOrigin>).detail;
      lastReadHash.current = origin.hash;
      lastReadIndex.current = origin.index;
    };
    const read = (event: PopStateEvent | HashChangeEvent) => {
      if (isPrototypeHistoryRestoring(event)) return;
      if (window.location.hash === "#main") return;
      if (window.location.hash === lastReadHash.current) return;
      const rawPage = window.location.hash.slice(1).split("?")[0] as Page;
      const nextPage = pages.has(rawPage) ? rawPage : "home";
      if (
        !allowPrototypeNavigation(nextPage, event, {
          hash: lastReadHash.current,
          index: lastReadIndex.current,
        })
      ) {
        return;
      }
      pageFromHash();
      lastReadHash.current = window.location.hash;
      lastReadIndex.current = historyEntryIndex();
      setPublicSquare(publicSquareFromHash());
      // Opening, updating or closing the public list leaves the home input
      // and any pending redemption untouched.
      if (nextPage === "home" && currentRoute.current.page === "home") return;
      // Merchant/payment modal history changes the view, not the page or inputs.
      if (
        ["merchant", "payment"].includes(nextPage) &&
        nextPage === currentRoute.current.page
      ) {
        setWorkbenchContext(workbenchRoute());
        return;
      }
      revision.current++;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setBusy(false);
      setAutoClaim(null);
      setUncertain(false);
      beginTransition(nextPage, activityFromHash(identity, bootstrap?.active));
      setPage(nextPage);
      document
        .getElementById("main")
        ?.scrollTo({ top: 0, behavior: "instant" });
      if (nextPage === "activity") {
        const found = activityFromHash(identity, bootstrap?.active);
        setMissingActivity(!found);
        if (found) setActive(found);
      }
      setWorkbenchContext(workbenchRoute());
      setPassword("");
      setMatches(null);
      setLocatorMatches(null);
      setMessage("");
      setAnimateId(null);
    };
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    window.addEventListener(PROTOTYPE_HISTORY_CHANGED, syncOrigin);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
      window.removeEventListener(PROTOTYPE_HISTORY_CHANGED, syncOrigin);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [identity, beginTransition, bootstrap?.active, setMessage]);
  function openPublicSquare() {
    setPanel(false);
    const next = { open: true, status: "all" as const, page: 1, scrollTop: 0 };
    pushPrototypeHistory(
      { prototypePublicSquare: { version: 1, scrollTop: 0 } },
      publicSquareHash(next),
    );
    lastReadHash.current = window.location.hash;
    lastReadIndex.current = historyEntryIndex();
    setPublicSquare(next);
  }
  function closePublicSquare() {
    if (window.history.state?.prototypePublicSquare?.version === 1) {
      window.history.back();
      return;
    }
    replacePrototypeHistory(null, "#home");
    lastReadHash.current = window.location.hash;
    lastReadIndex.current = historyEntryIndex();
    setPublicSquare((current) => ({ ...current, open: false }));
  }
  function updatePublicSquare(
    next: Pick<PublicSquareState, "status" | "page">,
  ) {
    const updated = { ...next, open: true, scrollTop: 0 };
    replacePrototypeHistory(
      { prototypePublicSquare: { version: 1, scrollTop: 0 } },
      publicSquareHash(updated),
    );
    lastReadHash.current = window.location.hash;
    lastReadIndex.current = historyEntryIndex();
    setPublicSquare(updated);
  }
  useEffect(() => {
    if (!panel) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPanel(false);
    }
    function closeOutside(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest(".scenario-panel, .prototype-review")
      )
        setPanel(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [panel]);
  function navigate(
    next: Page,
    options: {
      activity?: Activity;
      retainedPassword?: string;
      activityId?: string;
      editId?: string;
      autoClaimPassword?: string;
    } = {},
  ) {
    if (!allowPrototypeNavigation(next)) return false;
    if (options.activityId && next === "activity") {
      const managed = findWorkbenchActivity(identity, options.activityId);
      options.activity = managed
        ? toPrototypeActivity(managed)
        : (findPublishedWorkbenchActivity(options.activityId) ??
          gallerySamples.find((item) => item.id === options.activityId));
    }
    beginTransition(next, options.activity);
    revision.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const intent =
      next === "activity" &&
      options.activity &&
      options.autoClaimPassword !== undefined
        ? {
            id: revision.current,
            activity: options.activity,
            submitted: options.autoClaimPassword,
            identity,
          }
        : null;
    setAutoClaim(intent);
    setBusy(Boolean(intent));
    setUncertain(false);
    setMessage("");
    setPassword(options.retainedPassword ?? "");
    setMatches(null);
    setLocatorMatches(null);
    setAnimateId(null);
    setPublicSquare((current) => ({ ...current, open: false }));
    setPage(next);
    if (options.activity) setActive(options.activity);
    setMissingActivity(
      next === "activity" && Boolean(options.activityId) && !options.activity,
    );
    setWorkbenchContext({
      editId: options.editId,
      activityId: options.activityId,
    });
    pushPrototypeHistory(
      null,
      next === "activity"
        ? options.activityId && !options.activity
          ? `#activity?sample=${encodeURIComponent(options.activityId)}`
          : activityHash(options.activity ?? active)
        : `#${next}${options.editId ? `?edit=${encodeURIComponent(options.editId)}` : options.activityId ? `?activity=${encodeURIComponent(options.activityId)}` : ""}`,
    );
    lastReadHash.current = window.location.hash;
    lastReadIndex.current = historyEntryIndex();
    document.getElementById("main")?.scrollTo({ top: 0, behavior: "instant" });
    return true;
  }
  function openActivity(activity: Activity, retainedPassword = "") {
    setActive(activity);
    navigate("activity", { activity, retainedPassword });
  }
  function changeIdentity(next: Identity) {
    if (next === identity) return;
    privateSessions.current[identity] = {
      records,
      results,
      viewStates: activityStates,
      activityScenarios,
      solved,
    };
    revision.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTransition(null);
    setAutoClaim(null);
    setIdentity(next);
    if (page === "account" && next === "guest") setPanel(false);
    if (page === "activity") {
      const found = activityFromHash(next, bootstrap?.active);
      setMissingActivity(!found);
      if (found) setActive(found);
    }
    const saved = privateSessions.current[next];
    const seed = saved ?? createParticipationSeed(next);
    setRecords(seed.records);
    setResults(
      Object.fromEntries(
        Object.entries(seed.results).map(([id, result]) => [
          id,
          id === "random" || id === "random-ended"
            ? {
                ...result,
                rewardAmount: getSampleResult(id, rosterCase)?.rewardAmount,
              }
            : result,
        ]),
      ),
    );
    setActivityStates(seed.viewStates);
    setActivityScenarios(saved?.activityScenarios ?? {});
    setSolved(
      saved?.solved ??
        Object.fromEntries(
          Object.entries(seed.results).map(([id, result]) => [
            id,
            result.password ? [result.password] : [],
          ]),
        ),
    );
    setListState("ready");
    setPassword("");
    setMatches(null);
    setLocatorMatches(null);
    setMessage("");
    setAnimateId(null);
    setBusy(false);
    setUncertain(false);
  }
  function applyScenario(next: Scenario) {
    revision.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setScenario(next);
    setPassword("");
    setMessage("");
    setMatches(null);
    setLocatorMatches(null);
    setBusy(false);
    setUncertain(false);
    setAnimateId(null);
    const item =
      next === "random" ||
      next === "random-ended" ||
      next === "notes-drawing-ended"
        ? (gallerySamples.find((sample) => sample.id === next) ?? first)
        : next === "long"
          ? {
              ...first,
              author: "负责维护开源工具与活动资料的佬友",
              beforeInfo: longNote,
            }
          : [
                "registered",
                "drawing",
                "won",
                "not-won",
                "draw-empty",
                "draw-no-winners",
              ].includes(next)
            ? (activities[2] as Activity)
            : next === "ended"
              ? (activities[3] as Activity)
              : first;
    setActive(item);
    if (item.type === "draw")
      setDrawScenario(item, next === "notes-drawing-ended" ? "settling" : next);
    const eligible = identity === "standard";
    const state: Participation = !eligible
      ? "none"
      : next === "pending" || next === "multiple" || next === "random-ended"
        ? "claimed"
        : next === "registered"
          ? "registered"
          : next === "drawing"
            ? "drawing"
            : next === "won"
              ? "won"
              : next === "not-won" || next === "draw-no-winners"
                ? "not-won"
                : "none";
    setRecords((old) => ({ ...old, [item.id]: state }));
    const sample = getSampleResult(item.id, rosterCase);
    setResults((old) => {
      const updated = { ...old };
      if (eligible && state !== "none") {
        const reward = state === "claimed" || state === "won";
        updated[item.id] = sample ?? {
          participation: state,
          participatedAt: new Date().toISOString(),
          confirmedAt:
            reward && scenarioViewState(next).paymentProgress === "confirmed"
              ? new Date().toISOString()
              : null,
          password: item.passwords[0],
          rewardAmount: reward
            ? state === "won"
              ? "2.18"
              : item.amount
            : undefined,
          viewState: scenarioViewState(next),
        };
      } else delete updated[item.id];
      return updated;
    });
    setActivityStates((old) => ({
      ...old,
      [item.id]: {
        ...scenarioViewState(next),
        participation: state,
        ...(!eligible ? { paymentProgress: null } : {}),
      },
    }));
    setActivityScenarios((old) => ({ ...old, [item.id]: next }));
    setSolved((old) => ({
      ...old,
      [item.id]:
        state === "none"
          ? []
          : next === "multiple"
            ? item.passwords.slice(0, 2)
            : [item.passwords[0] ?? ""],
    }));
    navigate("activity", { activity: item });
  }
  function finishClaim(item: Activity, submitted: string) {
    const allocatedAmount =
      item.type === "ldc"
        ? (getSampleResult(item.id, rosterCase)?.rewardAmount ?? item.amount)
        : undefined;
    const instantClaim =
      item.type !== "draw"
        ? recordInstantClaim(item, allocatedAmount, rosterCase)
        : undefined;
    if (item.type === "draw")
      recordDrawRegistration(item, {
        name: "林间",
        username: "linjian",
        color: "sand",
      });
    const existing = records[item.id];
    const next =
      existing && existing !== "none"
        ? existing
        : item.type === "draw"
          ? "registered"
          : "claimed";
    setRecords((old) => ({ ...old, [item.id]: next }));
    setResults((old) => ({
      ...old,
      [item.id]: old[item.id] ?? {
        participation: next,
        participatedAt: instantClaim?.time ?? new Date().toISOString(),
        confirmedAt: item.type === "ldc" ? new Date().toISOString() : null,
        password: submitted,
        rewardAmount: allocatedAmount,
        viewState: {
          participation: next,
          paymentProgress: item.type === "ldc" ? "confirmed" : null,
        },
      },
    }));
    setActivityStates((old) => {
      const previous = projectActivityViewState(
        item,
        existing ?? "none",
        old[item.id],
      );
      return {
        ...old,
        [item.id]: {
          // Preserve explicit scenarios, but do not cache the current lifecycle
          // in a new participation: the author may end the activity afterward.
          ...old[item.id],
          participation: next,
          drawProgress:
            item.type === "draw" ? (previous.drawProgress ?? "waiting") : null,
          paymentProgress:
            item.type === "ldc" && (!existing || existing === "none")
              ? "confirmed"
              : previous.paymentProgress,
        },
      };
    });
    setSolved((old) =>
      old[item.id]?.length ? old : { ...old, [item.id]: [submitted] },
    );
    setActive(item);
    setBusy(false);
    setUncertain(false);
    setMessage("");
    setPassword("");
    setAnimateId(
      (!existing || existing === "none") && next === "claimed" ? item.id : null,
    );
  }
  function confirmClaimTarget(target: Activity, submitted: string) {
    if (timer.current !== null) return;
    setBusy(false);
    if (identity === "guest") {
      setMessage("请先登录。");
      return;
    }
    if (identity === "lite") {
      setMessage("创建、领取和报名需通过官方 Connect 升级。");
      return;
    }
    if (!inspectPassword(submitted).valid) {
      setMessage("口令不正确，请重新输入。");
      return;
    }
    if (target.lifecycle === "draft") {
      setMessage("活动尚未开放。");
      return;
    }
    if (target.username === "linjian") {
      setMessage("不能领取自己发起的 LDC 活动。");
      return;
    }
    const targetView = projectActivityViewState(
      target,
      records[target.id] ?? "none",
      activityStates[target.id],
    );
    const existing =
      target.type === "draw"
        ? resolveDrawParticipation(target, "linjian").participation
        : targetView.participation;
    if (existing !== "none") {
      setPassword("");
      return;
    }
    if (
      targetView.lifecycle === "ended" ||
      targetView.lifecycle === "archived"
    ) {
      return;
    }
    if (
      isActivityDeadlineReached(target, Date.now()) ||
      (target.type === "draw" && targetView.drawProgress !== "waiting")
    ) {
      setMessage(target.type === "draw" ? "报名已截止" : "已截止");
      return;
    }
    const matched = target.passwords.includes(submitted);
    const attemptKey = `${revision.current}:${target.id}:${submitted}`;
    if (pendingAttempt.current !== attemptKey) {
      pendingAttempt.current = attemptKey;
      recordAttempt(identity, target.id, submitted, {
        matched,
        successfulClaim: false,
      });
    }
    if (!matched) {
      pendingAttempt.current = null;
      setMessage("口令不正确，请重新输入。");
      return;
    }
    setBusy(true);
    setMessage("");
    const token = revision.current;
    const targetScenario = activityScenarios[target.id] ?? "ready";
    timer.current = setTimeout(
      () => {
        if (token !== revision.current) return;
        timer.current = null;
        if (isActivityDeadlineReached(target, Date.now())) {
          setBusy(false);
          setUncertain(false);
          setMessage(target.type === "draw" ? "报名已截止" : "已截止");
          return;
        }
        if (targetScenario === "failure" && !uncertain) {
          setBusy(false);
          setUncertain(true);
          setMessage("结果暂未确认，请再次确认。");
          return;
        }
        finishClaim(target, submitted);
        markAttemptSuccessful(identity, target.id, submitted);
        pendingAttempt.current = null;
      },
      targetScenario === "slow" ? 3200 : 550,
    );
  }
  function chooseClaimMatch(item: Activity) {
    if (!matches || matches.revision !== revision.current) return;
    openForRedemption(item, matches.submitted);
  }
  function openForRedemption(item: Activity, submitted: string) {
    navigate("activity", {
      activity: item,
      retainedPassword: submitted,
      autoClaimPassword: submitted,
    });
  }
  function publicHomeActivities() {
    return [
      ...new Map(
        [...availableActivities, ...listPublishedWorkbenchActivities()]
          .filter((item) => item.lifecycle !== "draft")
          .map((item) => [item.id, item]),
      ).values(),
    ];
  }
  function prototypeHashActivityId(input: string) {
    try {
      const url = new URL(input.trim(), window.location.origin);
      if (
        url.origin !== window.location.origin ||
        url.pathname !== "/" ||
        url.search
      )
        return null;
      const [target, query = ""] = url.hash.slice(1).split("?");
      if (target !== "activity") return null;
      return new URLSearchParams(query).get("sample");
    } catch {
      return null;
    }
  }
  function classifyPrototypeHomeEntry() {
    const classified = classifyHomeEntry(password, window.location.origin);
    if (classified.kind !== "password") return classified;
    const prototypeId = prototypeHashActivityId(password);
    if (!prototypeId) return classified;
    return { kind: "activity" as const, id: prototypeId };
  }
  function openHomeActivityId(inputId: string) {
    const id = resolvePrototypeActivityId(inputId);
    const target = publicHomeActivities().find((item) => item.id === id);
    navigate("activity", target ? { activity: target } : { activityId: id });
  }
  function findHomeTopicActivities(topic: {
    topicId: string;
    postNumber: number;
  }) {
    const found = publicHomeActivities().filter((activity) => {
      const associated = normalizePrototypeTopicLink(activity.topicUrl ?? "");
      return (
        associated?.topicId === topic.topicId &&
        associated.postNumber === topic.postNumber
      );
    });
    if (found.length === 1) {
      navigate("activity", { activity: found[0] as Activity });
      return;
    }
    if (found.length > 1) {
      setLocatorMatches({ items: found, revision: revision.current });
      setMatches(null);
      setMessage("");
      return;
    }
    setLocatorMatches(null);
    setMatches(null);
    setMessage("未匹配到活动。");
  }
  function chooseLocatorMatch(item: Activity) {
    if (!locatorMatches || locatorMatches.revision !== revision.current) return;
    navigate("activity", { activity: item });
  }
  function submitHomeEntry() {
    if (homeComposing) return;
    if (!password.length && !uncertain) return;
    if (busy || uncertain || timer.current !== null) {
      claim(true);
      return;
    }
    const entry = classifyPrototypeHomeEntry();
    if (entry.kind === "activity") {
      openHomeActivityId(entry.id);
      return;
    }
    if (entry.kind === "topic") {
      findHomeTopicActivities(entry);
      return;
    }
    claim(true);
  }
  function claim(fromHome = false) {
    if (busy || timer.current !== null) return;
    if (!inspectPassword(password).valid) {
      setMessage("请先检查口令中的标记。");
      return;
    }
    if (identity === "guest") {
      setMessage("请先登录。");
      return;
    }
    if (identity === "lite") {
      setMessage("创建、领取和报名需通过官方 Connect 升级。");
      return;
    }
    const found = fromHome
      ? availableActivities.filter(
          (item) =>
            item.lifecycle !== "draft" && item.passwords.includes(password),
        )
      : active.passwords.includes(password)
        ? [active]
        : [];
    if (!found.length) {
      setMessage("口令不正确。");
      return;
    }
    if (found.length > 1) {
      setMatches({
        items: found,
        submitted: password,
        revision: revision.current,
      });
      setMessage("");
      return;
    }
    const target = found[0] as Activity;
    if (fromHome) openForRedemption(target, password);
    else confirmClaimTarget(target, password);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: A committed navigation consumes its intent once; state rerenders must never resubmit it.
  useEffect(() => {
    if (!autoClaim || consumedAutoClaim.current === autoClaim.id) return;
    if (
      autoClaim.id !== revision.current ||
      autoClaim.identity !== identity ||
      page !== "activity" ||
      active.id !== autoClaim.activity.id
    )
      return;
    consumedAutoClaim.current = autoClaim.id;
    setAutoClaim(null);
    confirmClaimTarget(active, autoClaim.submitted);
  }, [autoClaim, page, active.id, identity]);
  function settle() {
    if (identity !== "standard" || active.type !== "draw") return;
    setDrawScenario(active, "won");
    setRecords((old) => ({ ...old, [active.id]: "won" }));
    setResults((old) => ({
      ...old,
      [active.id]: {
        ...old[active.id],
        participation: "won",
        confirmedAt: new Date().toISOString(),
        participatedAt:
          old[active.id]?.participatedAt ?? new Date().toISOString(),
        password: old[active.id]?.password ?? solved[active.id]?.[0],
        rewardAmount:
          drawWinnerExamples.find((entry) => entry.username === "linjian")
            ?.amount ?? "2.18",
        viewState: {
          lifecycle: "ended",
          participation: "won",
          drawProgress: "completed",
          paymentProgress: "confirmed",
        },
      },
    }));
    setActivityStates((old) => ({
      ...old,
      [active.id]: {
        ...projectActivityViewState(active, participation, old[active.id]),
        lifecycle: "ended",
        participation: "won",
        drawProgress: "completed",
        paymentProgress: "confirmed",
      },
    }));
    setAnimateId(active.id);
  }

  const projectedRecords = { ...records };
  const projectedResults = { ...results };
  const projectedStates = { ...activityStates };
  for (const item of availableActivities) {
    if (item.type !== "draw") continue;
    const draw = getDrawRoster(item);
    const own =
      identity === "standard"
        ? resolveDrawParticipation(item, "linjian")
        : { participation: "none" as const };
    const state = {
      ...projectActivityViewState(
        item,
        own.participation,
        activityStates[item.id],
      ),
      drawProgress: draw.progress,
      participation: own.participation,
    };
    if (
      state.lifecycle !== "archived" &&
      (draw.progress === "completed" || draw.progress === "empty")
    )
      state.lifecycle = "ended";
    state.drawProgress = effectiveDrawProgress(item, state);
    if (own.participation !== "won") state.paymentProgress = null;
    projectedStates[item.id] = state;
    if (own.participation === "none") {
      delete projectedRecords[item.id];
      delete projectedResults[item.id];
    } else {
      projectedRecords[item.id] = own.participation;
      projectedResults[item.id] = {
        ...results[item.id],
        participation: own.participation,
        participatedAt:
          own.participatedAt ?? results[item.id]?.participatedAt ?? "",
        rewardAmount: own.rewardAmount,
        viewState: state,
      };
    }
  }

  // The history list and account totals share one deduplicated participation
  // projection; registering and later winning remain a single activity.
  const participatedActivities =
    identity === "guest"
      ? []
      : [
          ...new Map(
            availableActivities
              .filter((item) => {
                const record = projectedRecords[item.id];
                return record !== undefined && record !== "none";
              })
              .map((item) => [item.id, item]),
          ).values(),
        ];

  const nav = [
    { page: "home" as Page, label: "兑奖", icon: Home },
    { page: "participations" as Page, label: "活动历史", icon: Gift },
    { page: "account" as Page, label: "我的", icon: UserRound },
    ...(identity === "standard"
      ? [{ page: "admin" as Page, label: "管理", icon: Settings2 }]
      : []),
  ];
  const navIsActive = (target: Page) =>
    target === page ||
    (target === "home" && page === "activity") ||
    (target === "participations" &&
      (page === "manage" ||
        page === "statistics" ||
        (page === "create" && Boolean(workbenchContext.editId)))) ||
    (target === "account" && ["merchant", "payment"].includes(page));
  const guestLogin = page === "account" && identity === "guest";
  const homeEntry =
    busy || uncertain || homeComposing
      ? { kind: "password" as const }
      : classifyPrototypeHomeEntry();
  const homeLocatorMode = homeEntry.kind !== "password";
  return (
    <div
      className={`tool-shell${guestLogin ? " tool-shell--guest-login" : ""}`}
    >
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      {!guestLogin && (
        <div className="prototype-review">
          <span>
            <span className="review-dot" /> 原型 · 第 1 批
            <span className="review-sub">界面修订 / 虚拟数据</span>
          </span>
          <div className="prototype-review-actions">
            <a
              href="#svg-gallery"
              aria-current={page === "svg-gallery" ? "page" : undefined}
            >
              SVG 红包总览
            </a>
            <button
              type="button"
              onClick={() => setPanel(!panel)}
              aria-expanded={panel}
            >
              <Settings2 size={13} />
              场景与身份
              <ChevronDown size={13} />
            </button>
          </div>
        </div>
      )}
      {!guestLogin && panel && (
        <aside className="scenario-panel" aria-label="原型场景">
          <div>
            <h2>原型场景</h2>
            <p>本地虚拟数据。可切换身份与活动状态。</p>
          </div>
          <label>
            体验身份
            <select
              value={identity}
              onChange={(e) => changeIdentity(e.target.value as Identity)}
            >
              <option value="standard">普通账号</option>
              <option value="lite">青春版账号</option>
              <option value="guest">未登录</option>
            </select>
          </label>
          <label>
            活动状态
            <select
              value={scenario}
              onChange={(e) => applyScenario(e.target.value as Scenario)}
            >
              {scenarioOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            列表场景
            <select
              value={listState}
              onChange={(event) =>
                setListState(event.target.value as typeof listState)
              }
            >
              <option value="ready">有记录</option>
              <option value="empty">空列表</option>
              <option value="loading">正在加载</option>
              <option value="error">加载失败</option>
            </select>
          </label>
          <label>
            拼手气称号样例
            <select
              value={rosterCase}
              onChange={(event) => {
                const next = event.target.value as RandomRosterCase;
                setRosterCase(next);
                setResults((old) =>
                  Object.fromEntries(
                    Object.entries(old).map(([id, result]) => [
                      id,
                      id === "random" || id === "random-ended"
                        ? {
                            ...result,
                            rewardAmount: getSampleResult(id, next)
                              ?.rewardAmount,
                          }
                        : result,
                    ]),
                  ),
                );
              }}
            >
              {Object.entries(randomRosterCaseLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="scenario-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                if (page !== "activity") navigate("activity");
                setPassword(active.passwords[0] ?? "");
              }}
            >
              填入正确口令
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                if (page !== "activity") navigate("activity");
                setPassword("　公共口令2026!１２３　");
              }}
            >
              填入非法字符
            </button>
            {["registered", "drawing"].includes(participation) && (
              <button type="button" className="button" onClick={settle}>
                预览中奖变化
              </button>
            )}
          </div>
          <div className="scenario-switches">
            <label>
              <input
                type="checkbox"
                checked={showRecipients}
                onChange={(e) => setShowRecipients(e.target.checked)}
              />
              展示领取名单
            </label>
            <label>
              <input
                type="checkbox"
                checked={fuzzy}
                onChange={(e) => setFuzzy(e.target.checked)}
              />
              模糊数量
            </label>
            <small>活动口令：{active.passwords.join(" / ")}</small>
          </div>
        </aside>
      )}
      {!guestLogin && (
        <header className="site-header">
          <div className="header-inner">
            <a className="wordmark" href="#home" aria-label="解meme 首页">
              <span className="brand-seal" aria-hidden="true">
                <Gift size={18} />
              </span>
              <span>解meme</span>
            </a>
            <LayoutGroup id="prototype-desktop-navigation">
              <nav className="desktop-nav" aria-label="主导航">
                {nav.map((item) => (
                  <a
                    key={item.page}
                    href={`#${item.page}`}
                    aria-current={navIsActive(item.page) ? "page" : undefined}
                  >
                    {item.label}
                    {navIsActive(item.page) && (
                      <motion.span
                        className="nav-active-indicator"
                        layoutId={motionOff ? undefined : "active-underline"}
                        initial={false}
                        transition={{
                          duration: motionOff ? 0 : 0.2,
                          ease: "easeOut",
                        }}
                        aria-hidden="true"
                      />
                    )}
                  </a>
                ))}
              </nav>
            </LayoutGroup>
            <div className="header-actions">
              <a className="create-link" href="#create">
                <Plus size={17} aria-hidden="true" />
                发起活动
              </a>
              {identity === "guest" ? (
                <a className="own-identity" href="#account">
                  登录
                </a>
              ) : (
                <a
                  className="own-identity"
                  href="#account"
                  aria-label="我的账号"
                >
                  <Avatar name="林间" color="sand" />
                  <span>林间</span>
                  {identity === "lite" && (
                    <span className="lite-badge">青春版</span>
                  )}
                </a>
              )}
            </div>
          </div>
        </header>
      )}
      <RedemptionTransitionProvider key={identity} transition={transition}>
        <motion.main layoutScroll id="main" className="site-main" tabIndex={-1}>
          <Suspense
            fallback={
              <div className="page-loading" role="status">
                <LoaderCircle className="spin" />
                正在加载页面…
              </div>
            }
          >
            <AnimatePresence initial={false} mode="popLayout">
              <RedemptionRouteFrame routeKey={routeKey} key={routeKey}>
                {page === "svg-gallery" && <SvgGallery />}
                {page === "admin" && (
                  <AdminPrototype key={identity} identity={identity} />
                )}
                {page === "home" && (
                  <div className="home-page">
                    <section className="home-hero" aria-label="口令兑奖">
                      <Envelope
                        open={false}
                        size="small"
                        presentationIdentity={identity}
                      />
                      <div className="home-exchange">
                        <button
                          ref={publicSquareEntry}
                          type="button"
                          className="public-square-entry"
                          aria-haspopup="dialog"
                          aria-expanded={publicSquare.open}
                          onClick={openPublicSquare}
                        >
                          <span>已公开的活动</span>
                          <ArrowRight size={14} aria-hidden="true" />
                        </button>
                        <PasswordInput
                          sharedFrame
                          id="home-password"
                          value={password}
                          onChange={(value) => {
                            setPassword(value);
                            setMessage("");
                            setMatches(null);
                            setLocatorMatches(null);
                          }}
                          label={HOME_ENTRY_LABEL}
                          hideLabel
                          placeholder=""
                          hintMode="invalid"
                          help={<Help label="口令输入">{HOME_ENTRY_HELP}</Help>}
                          mode={homeLocatorMode ? "locator" : "password"}
                          disabled={busy || uncertain}
                          onCompositionChange={setHomeComposing}
                          onSubmit={submitHomeEntry}
                        />
                        {(password.length > 0 || busy || uncertain) && (
                          <RedemptionAction
                            ref={homeActionRef}
                            type="button"
                            className="button claim-button"
                            disabled={busy || homeComposing}
                            title={operationFeedback.feedback?.detail}
                            aria-description={
                              operationFeedback.feedback?.detail
                            }
                            aria-label={
                              operationFeedback.feedback
                                ? `${uncertain ? "再次确认" : homeLocatorMode ? "跳转活动" : "兑奖"}，${operationFeedback.feedback.label}`
                                : undefined
                            }
                            onClick={submitHomeEntry}
                          >
                            {busy && (
                              <LoaderCircle className="spin" size={18} />
                            )}
                            <ActionFeedbackLabel
                              label={
                                busy
                                  ? "正在确认…"
                                  : uncertain
                                    ? "再次确认"
                                    : homeLocatorMode
                                      ? "跳转活动"
                                      : "兑奖"
                              }
                              feedback={
                                busy ? null : operationFeedback.feedback
                              }
                              reserve={["正在确认…", "口令不正确"]}
                            />
                          </RedemptionAction>
                        )}
                        {message && identity === "lite" && !homeLocatorMode && (
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => navigate("account")}
                          >
                            使用官方 Connect <ArrowUpRight size={16} />
                          </button>
                        )}
                      </div>
                    </section>
                    {matches && (
                      <ActivitySelectionDialog
                        title="选择要兑奖的活动"
                        items={matches.items}
                        onClose={() => setMatches(null)}
                        onOpen={chooseClaimMatch}
                        records={projectedRecords}
                        states={projectedStates}
                        fuzzy={fuzzy}
                        restoreFocus={homeActionRef.current}
                      />
                    )}
                    {locatorMatches && (
                      <ActivitySelectionDialog
                        title="选择活动"
                        items={locatorMatches.items}
                        onClose={() => setLocatorMatches(null)}
                        onOpen={chooseLocatorMatch}
                        records={projectedRecords}
                        states={projectedStates}
                        fuzzy={fuzzy}
                        restoreFocus={homeActionRef.current}
                      />
                    )}
                    {publicSquare.open && (
                      <PublicSquareDialog
                        onClose={closePublicSquare}
                        onOpen={openActivity}
                        restoreFocus={publicSquareEntry.current}
                        records={projectedRecords}
                        states={projectedStates}
                        fuzzy={fuzzy}
                        listState={listState}
                        onRetry={() => setListState("ready")}
                        selection={publicSquare}
                        onSelectionChange={updatePublicSquare}
                      />
                    )}
                  </div>
                )}
                {page === "activity" && missingActivity && (
                  <section className="empty-state">
                    <h1>活动不存在</h1>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => navigate("participations")}
                    >
                      查看活动历史
                    </button>
                  </section>
                )}
                {page === "activity" && !missingActivity && (
                  <ActivityPage
                    key={scope}
                    activity={active}
                    viewState={viewState}
                    animate={animateId === active.id}
                    identity={identity}
                    password={password}
                    setPassword={(value) => {
                      setPassword(value);
                      setMessage("");
                    }}
                    busy={busy}
                    reserveResultSpace={Boolean(autoClaim) || busy || uncertain}
                    uncertain={uncertain}
                    feedback={operationFeedback.feedback}
                    onClaim={() => claim()}
                    navigate={navigate}
                    solved={solved[active.id] ?? []}
                    onSolve={(word) =>
                      setSolved((old) => ({
                        ...old,
                        [active.id]: [
                          ...new Set([...(old[active.id] ?? []), word]),
                        ],
                      }))
                    }
                    showRecipients={showRecipients}
                    fuzzy={fuzzy}
                    rosterCase={rosterCase}
                    result={results[active.id]}
                    listState={listState}
                    onActivityUpdate={(next) => setActive(next)}
                  />
                )}
                {["participations", "manage"].includes(page) && (
                  <div className="history-heading">
                    <div className="history-heading-main">
                      <h1>活动历史</h1>
                      <SegmentedControl
                        label="活动历史分类"
                        mode="tabs"
                        value={page}
                        onChange={navigate}
                        options={[
                          { value: "manage", label: "我发起的" },
                          { value: "participations", label: "我参与的" },
                        ]}
                      />
                    </div>
                    {identity !== "guest" && (
                      <HistoryOverview
                        initiatedTotal={managed.activities.length}
                        participatedTotal={participatedActivities.length}
                      />
                    )}
                  </div>
                )}
                {page === "participations" && (
                  <Participations
                    activities={participatedActivities}
                    onOpen={openActivity}
                    navigate={navigate}
                    records={projectedRecords}
                    states={projectedStates}
                    results={projectedResults}
                    identity={identity}
                    listState={listState}
                    onRetry={() => setListState("ready")}
                  />
                )}
                {[
                  "create",
                  "manage",
                  "account",
                  "merchant",
                  "payment",
                  "statistics",
                ].includes(page) && (
                  <Workbench
                    key={`${page}:${identity}:${workbenchContext.editId ?? ""}:${workbenchContext.activityId ?? ""}`}
                    page={page}
                    navigate={navigate}
                    identity={identity}
                    onIdentityChange={changeIdentity}
                    {...workbenchContext}
                    listState={listState}
                    onRetry={() => setListState("ready")}
                  />
                )}
              </RedemptionRouteFrame>
            </AnimatePresence>
          </Suspense>
        </motion.main>
      </RedemptionTransitionProvider>
      {!guestLogin && (
        <LayoutGroup id="prototype-mobile-navigation">
          <nav className="mobile-nav" aria-label="手机导航">
            {nav.map(({ page: target, label, icon: Icon }) => (
              <a
                key={target}
                href={`#${target}`}
                aria-current={navIsActive(target) ? "page" : undefined}
              >
                <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                <span>{label}</span>
                {navIsActive(target) && (
                  <motion.span
                    className="nav-active-indicator"
                    layoutId={motionOff ? undefined : "active-underline"}
                    initial={false}
                    transition={{
                      duration: motionOff ? 0 : 0.2,
                      ease: "easeOut",
                    }}
                    aria-hidden="true"
                  />
                )}
              </a>
            ))}
          </nav>
        </LayoutGroup>
      )}
    </div>
  );
}

function ActivityPage({
  activity,
  viewState,
  animate,
  identity,
  password,
  setPassword,
  busy,
  reserveResultSpace,
  uncertain,
  feedback,
  onClaim,
  navigate,
  solved,
  onSolve,
  showRecipients,
  fuzzy,
  rosterCase,
  result,
  listState,
  onActivityUpdate,
}: {
  activity: Activity;
  viewState: ActivityViewState;
  animate: boolean;
  identity: Identity;
  password: string;
  setPassword: (value: string) => void;
  busy: boolean;
  reserveResultSpace: boolean;
  uncertain: boolean;
  feedback: ActionFeedback | null;
  onClaim: () => void;
  navigate: (
    page: Page,
    options?: { activityId?: string; editId?: string },
  ) => void;
  solved: string[];
  onSolve: (word: string) => void;
  showRecipients: boolean;
  fuzzy: boolean;
  rosterCase: RandomRosterCase;
  result?: ParticipationResult;
  listState: "ready" | "empty" | "loading" | "error";
  onActivityUpdate: (activity: Activity) => void;
}) {
  const participation = viewState.participation;
  const hasReward = participation === "claimed" || participation === "won";
  const registered = ["registered", "drawing", "won", "not-won"].includes(
    participation,
  );
  const ended =
    viewState.lifecycle === "ended" || viewState.lifecycle === "archived";
  const [solve, setSolve] = useState("");
  const solveFeedback = useActionFeedback(`${identity}:${activity.id}`);
  function setSolveMessage(message: string) {
    if (!message) {
      solveFeedback.clear();
      return;
    }
    solveFeedback.show(
      message === "口令验证成功。"
        ? "已解锁"
        : message === "该口令已解出。"
          ? "已解出"
          : message === "口令不正确。"
            ? "口令不正确"
            : "验证失败",
      message,
    );
  }
  const endFeedback = useActionFeedback(`${identity}:${activity.id}`);
  const [rosterOpen, setRosterOpen] = useState(false);
  const isPresent = useIsPresent();
  const draw = useDrawRoster(activity);
  const deadlineExpired = useDeadlineExpired({
    deadlineAt: activity.deadlineAt ?? null,
    active: viewState.lifecycle === "active",
  });
  const drawProgress = effectiveDrawProgress(activity, viewState);
  const completedDraw =
    activity.type === "draw" &&
    (drawProgress === "completed" || drawProgress === "empty");
  const drawing = activity.type === "draw" && drawProgress === "settling";
  const selectableRandom =
    activity.id === "random" || activity.id === "random-ended";
  const publicRecipients =
    activity.type === "draw"
      ? completedDraw
        ? draw.winners
        : []
      : publicClaimRoster(activity, selectableRandom ? rosterCase : undefined);
  const publicRemainingCount = Math.max(
    0,
    activity.count - publicRecipients.length,
  );
  const publicClaimedCount = activity.count - publicRemainingCount;
  const ownResult = hasReward
    ? (result ??
      getSampleResult(activity.id, selectableRandom ? rosterCase : undefined))
    : undefined;
  const ownAmount =
    (activity.type === "draw" && identity === "standard"
      ? resolveDrawParticipation(activity, "linjian").rewardAmount
      : undefined) ?? ownResult?.rewardAmount;
  const paper = envelopePresentation({
    activity,
    state: { ...viewState, drawProgress },
    identity,
    amount: ownAmount,
  });
  const image = envelopeImagePresentation({
    activity,
    state: { ...viewState, drawProgress },
    identity,
    amount: ownAmount,
    claimedAt:
      activity.type === "draw"
        ? draw.winners.find((winner) => winner.username === "linjian")?.time
        : ownResult?.participatedAt,
    updatedAt: new Date(prototypeStartedAt),
    quantityText: fuzzy
      ? null
      : activity.type === "draw"
        ? `${activity.count} 个获奖名额`
        : `剩余 ${publicRemainingCount} 份`,
  });
  const rosterLabel =
    activity.type === "draw"
      ? completedDraw
        ? "查看中奖名单"
        : "查看报名名单"
      : "查看领取名单";
  const metadata = getActivityPublicMetadata(activity, { fuzzy });
  const countdownActive =
    viewState.lifecycle === "active" &&
    !deadlineExpired &&
    (drawProgress === null || drawProgress === "waiting");
  const admissionClosed =
    deadlineExpired || (activity.type === "draw" && drawProgress !== "waiting");
  const passwords = projectPasswordAccess({
    activity,
    viewState,
    identity,
    solved,
    personalPassword: result?.password,
    expired: deadlineExpired,
  });
  const notes = projectActivityNotes(activity, viewState, identity);
  const noteContext = `${activity.id}:${identity}:${viewState.lifecycle}:${viewState.participation}:${activity.type === "draw" ? draw.progress : ""}`;
  const mainNotes = { before: notes.before, after: notes.after };
  const noteAuthor = {
    name: activity.author,
    username: activity.username,
    color: activity.color,
  };
  const statusSentence = activityStatusSentence(
    activity,
    { ...viewState, drawProgress },
    deadlineExpired,
  );
  const managedActivity = findWorkbenchActivity(identity, activity.id);
  const canManageActivity =
    identity !== "guest" &&
    activity.username === "linjian" &&
    viewState.lifecycle !== "draft" &&
    managedActivity?.status !== "draft" &&
    Boolean(managedActivity);
  const canViewRoster = showRecipients || canManageActivity;
  const closingLabel = activity.type === "draw" ? "报名已截止" : "已截止";
  const deadlineText = formatFullDateTime(metadata.deadlineAt);
  const canEndEarly =
    canManageActivity &&
    managedActivity?.status === "active" &&
    managedActivity.claimed === 0 &&
    (activity.type === "draw"
      ? draw.registrations.length === 0
      : publicRecipients.length === 0);
  function shareText(kind: "link" | "text" | "password", password?: string) {
    if (
      kind === "password" &&
      !passwords.known.some((item) => item.text === password)
    )
      return null;
    const url = buildPrototypeActivityShareUrl(
      activity.id,
      window.location.origin,
    );
    return kind === "link"
      ? url
      : [
          buildActivityShareText(activity, { fuzzy, url }),
          ...(kind === "password"
            ? [`${activity.type === "draw" ? "报名" : "兑换"}口令：${password}`]
            : []),
        ].join("\n");
  }
  function submitSolve() {
    if (
      !passwords.canSolve ||
      isActivityDeadlineReached(activity, Date.now())
    ) {
      setSolveMessage(closingLabel);
      return;
    }
    if (!inspectPassword(solve).valid) {
      setSolveMessage("请先检查口令格式。");
      return;
    }
    if (activity.passwords.includes(solve)) {
      const alreadySolved = solved.includes(solve);
      onSolve(solve);
      setSolve("");
      setSolveMessage(alreadySolved ? "该口令已解出。" : "口令验证成功。");
    } else setSolveMessage("口令不正确。");
  }
  function endEarly() {
    if (!managedActivity) return;
    if (!window.confirm("确定提前结束这个活动吗？")) return;
    const ended = endWorkbenchActivity(identity, managedActivity.id);
    const latest = findWorkbenchActivity(identity, managedActivity.id);
    if (!ended || !latest) {
      endFeedback.show("结束失败", "活动状态已变化，无法提前结束。");
      if (latest) onActivityUpdate(toPrototypeActivity(latest));
      return;
    }
    const next = toPrototypeActivity(latest);
    onActivityUpdate(next);
    endFeedback.show("已结束");
  }
  return (
    <div
      className="activity-page"
      data-lifecycle={viewState.lifecycle}
      data-participation={participation}
      data-draw-progress={drawProgress ?? "none"}
      data-payment-progress={viewState.paymentProgress ?? "none"}
    >
      <header className="activity-heading">
        <div className="activity-title-row">
          <CompactIconButton
            className="activity-back-button"
            aria-label="返回兑奖"
            onClick={() => navigate("home")}
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </CompactIconButton>
          <h1>{activity.title}</h1>
          <div className="activity-title-actions">
            <PrototypeActivityImageShare
              activity={activity}
              identity={identity}
              fuzzy={fuzzy}
              activityHref={buildPrototypeActivityShareUrl(
                activity.id,
                window.location.origin,
              )}
              visiblePasswords={passwords.known}
              getCopyText={shareText}
            />
            {canManageActivity && managedActivity && (
              <ActionMenu
                label="管理活动"
                items={[
                  {
                    label: "编辑配置",
                    onSelect: () =>
                      navigate("create", { editId: managedActivity.id }),
                  },
                  {
                    label: "付款记录",
                    onSelect: () =>
                      navigate("payment", {
                        activityId: managedActivity.id,
                      }),
                  },
                  ...(managedActivity.config.dedicated
                    ? [
                        {
                          label: "兑换尝试统计",
                          onSelect: () =>
                            navigate("statistics", {
                              activityId: managedActivity.id,
                            }),
                        },
                      ]
                    : []),
                  ...(canEndEarly || endFeedback.feedback
                    ? [
                        {
                          label: "提前结束",
                          feedback: endFeedback.feedback,
                          keepOpen: true,
                          disabled: !canEndEarly,
                          reserve: ["结束失败"],
                          onSelect: endEarly,
                        },
                      ]
                    : []),
                ]}
              />
            )}
          </div>
        </div>
        <div className="activity-meta">
          <UserIdentity
            name={activity.author}
            username={activity.username}
            color={activity.color}
          />
          <span className="activity-reward-kind">{metadata.rewardLabel}</span>
          {metadata.poolLabel && <span>总奖池 {metadata.poolLabel}</span>}
          {activity.type !== "draw" && !fuzzy ? (
            <span className="activity-quantity">
              <span aria-hidden="true">
                {publicQuantityLabel({
                  ...activity,
                  remaining: publicRemainingCount,
                })}
              </span>
              <span className="sr-only">{`已领取 ${publicClaimedCount} 份，共 ${activity.count} 份`}</span>
            </span>
          ) : (
            <span>
              {fuzzy
                ? completedDraw
                  ? "开奖结果已揭晓"
                  : fuzzyQuantityLabel(activity)
                : activity.type === "draw"
                  ? completedDraw
                    ? `${publicRecipients.length} 人中奖 · 最多 ${activity.count} 个名额`
                    : `最多 ${activity.count} 个获奖名额`
                  : fuzzyQuantityLabel(activity)}
            </span>
          )}
          {!countdownActive && (
            <span>
              {drawing
                ? "正在开奖"
                : completedDraw
                  ? "开奖结果已公布"
                  : deadlineExpired && !ended
                    ? "已截止"
                    : activityLifecycleLabels[viewState.lifecycle]}
            </span>
          )}
          {countdownActive && metadata.deadlineAt && (
            <div className="activity-deadline">
              <ActivityCountdown
                deadlineAt={metadata.deadlineAt}
                active={countdownActive}
                kind={activity.type === "draw" ? "draw" : "instant"}
              />
              <Help label="截止时间说明">
                {activity.type === "draw" ? "最晚开奖" : "截止时间"}：
                {deadlineText}
              </Help>
            </div>
          )}
        </div>
      </header>
      <section className={`claim-layout ${hasReward ? "has-reward" : ""}`}>
        <div className="claim-art">
          <Envelope
            key={identity}
            open={Boolean(paper)}
            waiting={registered || drawing}
            reward={paper}
            presentation={image}
            presentationIdentity={identity}
            author={{
              name: activity.author,
              username: activity.username,
              color: activity.color,
            }}
            payment={{
              status: viewState.paymentProgress,
              confirmedAt: ownResult?.confirmedAt,
            }}
            onOpenRoster={canViewRoster ? () => setRosterOpen(true) : undefined}
            rosterLabel={rosterLabel}
            animationToken={animate ? activity.id : null}
            size="detail"
            reserveResultSpace={reserveResultSpace && activity.type !== "draw"}
          />
        </div>
        <div className="claim-copy">
          <p className="activity-status-copy">{statusSentence}</p>
          {!paper && canViewRoster && (
            <button
              className="text-button roster-entry"
              type="button"
              aria-haspopup="dialog"
              onClick={() => setRosterOpen(true)}
            >
              {rosterLabel}
            </button>
          )}
          {!hasReward && (
            <ActivityNotes
              key={noteContext}
              notes={mainNotes}
              author={noteAuthor}
            />
          )}
          {hasReward ? (
            ["waiting", "attention"].includes(
              viewState.paymentProgress ?? "",
            ) ? (
              <p className="eligibility-note">
                {viewState.paymentProgress === "waiting"
                  ? "奖励已保留，等待作者恢复发放。"
                  : "发放需要处理，奖励已保留。"}
              </p>
            ) : null
          ) : registered && !paper ? (
            <>
              <div className="draw-ticket">
                <span>
                  报名时间
                  <b>
                    {result?.participatedAt ? (
                      <ShortTime value={result.participatedAt} />
                    ) : (
                      "已记录"
                    )}
                  </b>
                </span>
                {deadlineText !== "—" && (
                  <span>
                    最晚开奖<b>{deadlineText}</b>
                  </span>
                )}
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => navigate("participations")}
              >
                查看我的参与
                <ArrowRight size={16} />
              </button>
            </>
          ) : drawing ||
            paper ||
            admissionClosed ||
            viewState.lifecycle === "draft" ? null : activity.username ===
            "linjian" ? (
            <p className="eligibility-note">不能领取自己发起的 LDC 活动</p>
          ) : identity === "guest" ? (
            <div className="eligibility-note">
              <p>请先登录。</p>
              <button
                type="button"
                className="button"
                onClick={() => navigate("account")}
              >
                登录领取
                <ArrowRight size={17} />
              </button>
            </div>
          ) : identity === "lite" ? (
            <div className="eligibility-note">
              <span className="lite-badge">青春版</span>
              <p>LDC 奖励需使用官方 Connect 登录。</p>
              <button
                type="button"
                className="button"
                onClick={() => navigate("account")}
              >
                使用官方 Connect
                <ArrowUpRight size={16} />
              </button>
            </div>
          ) : (
            <form
              className="claim-form"
              onSubmit={(event) => {
                event.preventDefault();
                onClaim();
              }}
            >
              <PasswordInput
                sharedFrame
                id="activity-password"
                label="兑换口令"
                value={password}
                onChange={setPassword}
                disabled={busy || uncertain}
                onSubmit={onClaim}
              />
              <RedemptionAction
                type="submit"
                className="button claim-button"
                disabled={busy}
                title={feedback?.detail}
                aria-description={feedback?.detail}
                aria-label={
                  feedback && !busy
                    ? `${uncertain ? "再次确认" : activity.type === "draw" ? "报名" : "领取红包"}，${feedback.label}`
                    : undefined
                }
              >
                {busy ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <Gift size={18} />
                )}{" "}
                <ActionFeedbackLabel
                  label={
                    busy
                      ? "正在确认…"
                      : uncertain
                        ? "再次确认"
                        : activity.type === "draw"
                          ? "报名"
                          : "领取红包"
                  }
                  feedback={busy ? null : feedback}
                  reserve={["正在确认…", "口令不正确"]}
                />
                <ArrowRight size={17} />
              </RedemptionAction>
            </form>
          )}
          {hasReward && (
            <ActivityNotes
              key={noteContext}
              notes={mainNotes}
              author={noteAuthor}
            />
          )}
        </div>
      </section>
      <section className="password-section">
        <PasswordList
          defaultRevealed
          known={passwords.known}
          hiddenCount={passwords.hiddenCount}
          scope={`${identity}:${activity.id}`}
          heading={<h2>活动口令</h2>}
        />
        {passwords.canSolve && (
          <div className="solve-row">
            <div className="solve-heading">
              <h3>验证其他口令</h3>
              <span className="muted">剩余 {passwords.hiddenCount} 个</span>
              <Help label="验证其他口令说明">
                解出其他口令不会增加奖励、报名资格或中奖机会。
              </Help>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submitSolve();
              }}
            >
              <PasswordInput
                id="solve-password"
                value={solve}
                onChange={(value) => {
                  setSolve(value);
                  setSolveMessage("");
                }}
                label="验证其他口令"
                hideLabel
                compact
                onSubmit={submitSolve}
                action={
                  <ActionButton
                    type="submit"
                    className="button secondary"
                    label="验证口令"
                    feedback={solveFeedback.feedback}
                    reserve={["口令不正确", "验证失败"]}
                  />
                }
              />
            </form>
          </div>
        )}
      </section>
      <PublicRoster
        open={rosterOpen && isPresent}
        onClose={() => setRosterOpen(false)}
        activityTitle={activity.title}
        author={{
          name: activity.author,
          username: activity.username,
          color: activity.color,
        }}
        listState={listState === "empty" ? "ready" : listState}
        activityId={activity.id}
        type={activity.type}
        openedAt={activity.openedAt}
        drawProgress={drawProgress}
        registrations={listState === "empty" ? [] : draw.registrations}
        recipients={listState === "empty" ? [] : publicRecipients}
        identity={identity}
        onOwnProfile={() => navigate("account")}
        fuzzy={fuzzy}
        showRecipients={showRecipients}
        authorView={canManageActivity}
        resetKey={rosterCase}
      />
      {notes.ended && (
        <ActivityNoteSection
          key={`ended:${noteContext}`}
          stage="ended"
          content={notes.ended}
          author={noteAuthor}
        />
      )}
    </div>
  );
}

type ListState = "ready" | "empty" | "loading" | "error";

type PublicSquareProps = {
  onOpen: (activity: Activity) => void;
  records: Record<string, Participation>;
  states: Record<string, ActivityViewStateOverrides>;
  fuzzy: boolean;
  listState: ListState;
  onRetry: () => void;
  selection: PublicSquareState;
  onSelectionChange: (
    state: Pick<PublicSquareState, "status" | "page">,
  ) => void;
};

function PublicSquareDialog({
  onClose,
  onOpen,
  restoreFocus,
  ...props
}: PublicSquareProps & {
  onClose: () => void;
  restoreFocus: HTMLElement | null;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  const selected = useRef(false);
  const opener = useRef(restoreFocus);
  const present = useIsPresent();

  useLayoutEffect(() => {
    if (!dialog || !present) return;
    opener.current ??= document.querySelector<HTMLElement>(
      ".public-square-entry",
    );
    dialog.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (
        !selected.current &&
        opener.current?.isConnected &&
        window.location.hash.split("?")[0] === "#home" &&
        !document.querySelector("dialog[open]")
      )
        opener.current.focus({ preventScroll: true });
    };
  }, [dialog, present]);

  useLayoutEffect(() => {
    const scroll = dialog?.querySelector<HTMLElement>(".list-panel__scroll");
    if (scroll) scroll.scrollTop = props.selection.scrollTop;
  }, [dialog, props.selection.scrollTop]);

  function isBackdrop(event: ReactPointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  }

  if (!present) return null;
  return createPortal(
    <dialog
      ref={setDialog}
      className="public-square-dialog"
      aria-label="活动广场"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropPress.current = isBackdrop(event);
      }}
      onPointerUp={(event) => {
        if (backdropPress.current && isBackdrop(event)) onClose();
        backdropPress.current = false;
      }}
      onScrollCapture={(event) => {
        if (!present || !dialog?.open || !publicSquareFromHash().open) return;
        if (!(event.target instanceof HTMLElement)) return;
        if (!event.target.matches(".list-panel__scroll")) return;
        replacePrototypeHistory({
          ...window.history.state,
          prototypePublicSquare: {
            version: 1,
            scrollTop: event.target.scrollTop,
          },
        });
      }}
    >
      <PortalTargetProvider target={dialog}>
        <Gallery
          {...props}
          onClose={onClose}
          closeButton={closeButton}
          onOpen={(activity) => {
            selected.current = true;
            dialog?.close();
            onOpen(activity);
          }}
        />
      </PortalTargetProvider>
    </dialog>,
    document.body,
  );
}

function Gallery({
  onOpen,
  records,
  states,
  fuzzy,
  listState,
  onRetry,
  selection,
  onSelectionChange,
  onClose,
  closeButton,
}: PublicSquareProps & {
  onClose: () => void;
  closeButton: RefObject<HTMLButtonElement | null>;
}) {
  const statusFilter = selection.status;
  const setStatusFilter = (status: PublicSquareState["status"]) =>
    onSelectionChange({ status, page: 1 });
  useClockSelector((now) =>
    gallerySamples
      .map((item) => (isActivityDeadlineReached(item, now) ? "1" : "0"))
      .join(""),
  );
  const publicStates = Object.fromEntries(
    gallerySamples.map((item) => {
      const state = projectActivityViewState(
        item,
        records[item.id] ?? "none",
        states[item.id],
      );
      if (item.type === "draw")
        state.drawProgress = getDrawRoster(item).progress;
      state.drawProgress = effectiveDrawProgress(item, state);
      if (state.lifecycle !== "draft" && state.lifecycle !== "archived")
        state.lifecycle = publicActivityStatus(item, state);
      return [item.id, state];
    }),
  );
  const items =
    listState === "empty"
      ? []
      : gallerySamples
          .map((item) =>
            item.type === "draw"
              ? item
              : {
                  ...item,
                  remaining: Math.max(
                    0,
                    item.count - publicClaimRoster(item).length,
                  ),
                },
          )
          .filter(
            (item) =>
              (!item.lifecycle ||
                item.lifecycle === "active" ||
                item.lifecycle === "ended") &&
              (statusFilter === "all" ||
                publicStates[item.id]?.lifecycle === statusFilter),
          );
  const lastPage = Math.max(1, Math.ceil(items.length / 20));
  const currentPage =
    listState === "ready" || listState === "empty"
      ? Math.min(selection.page, lastPage)
      : selection.page;
  const pageItems = items.slice((currentPage - 1) * 20, currentPage * 20);
  return (
    <section className="gallery-page list-page">
      <header className="page-title public-square-header">
        <h2>活动广场</h2>
        <section className="history-statistics" aria-label="活动广场统计">
          <div data-statistic="public">
            <span>公开活动</span>
            <span className="history-statistics-value">
              {listState === "loading" ? "—" : items.length}
              <small>场</small>
            </span>
          </div>
        </section>
        <CompactIconButton
          ref={closeButton}
          aria-label="关闭活动广场"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </CompactIconButton>
      </header>
      <div className="gallery-toolbar">
        <div className="gallery-status-filter">
          <ActionMenu
            label={`状态：${statusFilter === "all" ? "全部" : statusFilter === "active" ? "进行中" : "已结束"}`}
            ariaLabel="活动状态筛选"
            items={[
              {
                label: "全部",
                selected: statusFilter === "all",
                onSelect: () => setStatusFilter("all"),
              },
              {
                label: "进行中",
                selected: statusFilter === "active",
                onSelect: () => setStatusFilter("active"),
              },
              {
                label: "已结束",
                selected: statusFilter === "ended",
                onSelect: () => setStatusFilter("ended"),
              },
            ]}
          />
          {statusFilter !== "all" && (
            <CompactIconButton
              aria-label="清空状态筛选"
              onClick={() => setStatusFilter("all")}
            >
              <X size={16} />
            </CompactIconButton>
          )}
        </div>
        <CompactIconButton
          className="list-refresh-button"
          aria-label="刷新活动列表"
          disabled={listState === "loading"}
          onClick={onRetry}
        >
          <RefreshCw size={16} />
        </CompactIconButton>
      </div>
      <ListPanel
        state={listState === "ready" && !items.length ? "empty" : listState}
        onRetry={onRetry}
        resetKey={`${statusFilter}:${currentPage}`}
        footer={
          <Pagination
            label="活动广场分页"
            page={currentPage}
            hasNext={listState === "ready" && currentPage < lastPage}
            onPageChange={(page) =>
              onSelectionChange({ status: statusFilter, page })
            }
            busy={listState === "loading"}
          />
        }
      >
        <ActivityRows
          activities={pageItems}
          onOpen={onOpen}
          records={records}
          states={publicStates}
          fuzzy={fuzzy}
        />
      </ListPanel>
    </section>
  );
}

function HistoryOverview({
  initiatedTotal,
  participatedTotal,
}: {
  initiatedTotal: number;
  participatedTotal: number;
}) {
  return (
    <section className="history-statistics" aria-label="活动历史统计">
      <div data-statistic="initiated">
        <span>已发起</span>
        <span className="history-statistics-value">
          {initiatedTotal}
          <small>场</small>
        </span>
      </div>
      <div data-statistic="participated">
        <span>已参与</span>
        <span className="history-statistics-value">
          {participatedTotal}
          <small>场</small>
        </span>
      </div>
    </section>
  );
}

function Participations({
  activities,
  onOpen,
  navigate,
  records,
  states,
  results,
  identity,
  listState,
  onRetry,
}: {
  activities: Activity[];
  onOpen: (activity: Activity) => void;
  navigate: (page: Page) => void;
  records: Record<string, Participation>;
  states: Record<string, ActivityViewStateOverrides>;
  results: Record<string, ParticipationResult>;
  identity: Identity;
  listState: ListState;
  onRetry: () => void;
}) {
  const items = listState === "empty" ? [] : activities;
  const paging = usePagination(items, `${identity}:${listState}`);
  if (identity === "guest")
    return (
      <section className="empty-state">
        <h2>登录后查看参与记录</h2>
        <button
          type="button"
          className="button"
          onClick={() => navigate("account")}
        >
          登录
        </button>
      </section>
    );
  return (
    <section className="participations-page work-page work-list-page list-page">
      <div className="activity-list-toolbar">
        <CompactIconButton
          className="list-refresh-button"
          aria-label="刷新参与记录"
          disabled={listState === "loading"}
          onClick={onRetry}
        >
          <RefreshCw size={16} />
        </CompactIconButton>
      </div>
      <ListPanel
        state={listState === "ready" && !items.length ? "empty" : listState}
        emptyText="暂无参与记录"
        onRetry={onRetry}
        resetKey={`${paging.page}:${listState}`}
        footer={
          <Pagination
            label="参与记录分页"
            page={paging.page}
            hasNext={listState === "ready" && paging.hasNext}
            onPageChange={paging.setPage}
            busy={listState === "loading"}
          />
        }
      >
        <ActivityRows
          activities={paging.pageItems}
          onOpen={onOpen}
          records={records}
          states={states}
          results={results}
          history
        />
      </ListPanel>
    </section>
  );
}
