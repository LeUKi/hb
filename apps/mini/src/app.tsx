import type {
  ClaimDetail,
  MiniHongbaoResponse,
  MiniLiveMessage,
  RegistrationDetail,
} from "@hb/contracts";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useSetAtom, useStore } from "jotai";
import { Check, Copy, RotateCcw, X } from "lucide-react";
import { MotionConfig } from "motion/react";
import {
  createContext,
  type KeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDrawStep } from "../../web/src/components/hongbao/clock";
import {
  HongbaoHero,
  hongbaoSizes,
  sizeVars,
} from "../../web/src/components/hongbao/hero";
import { LiveViewers } from "../../web/src/components/hongbao/live-viewers";
import { NoteContent } from "../../web/src/components/hongbao/note-content";
import { RosterPanel } from "../../web/src/components/hongbao/roster-panel";
import {
  sealOf,
  useDrawMoments,
} from "../../web/src/components/hongbao/seal-state";
import { SelfClaimDialog } from "../../web/src/components/hongbao/self-claim-dialog";
import type { Hongbao } from "../../web/src/components/hongbao/use-hongbao";
import { WindowDialog } from "../../web/src/components/shell/window-dialog";
import {
  type WindowInfo,
  WindowInfoProvider,
} from "../../web/src/components/shell/window-info";
import {
  Button,
  buttonHeight,
  buttonRadius,
  useButtonShape,
} from "../../web/src/components/ui/button";
import { TextInput } from "../../web/src/components/ui/field";
import { MorphLabel } from "../../web/src/components/ui/morph-label";
import { Reveal } from "../../web/src/components/ui/reveal";
import {
  radius,
  Squircle,
  SquircleFill,
} from "../../web/src/components/ui/squircle";
import { activityCode, RED_PACKET } from "../../web/src/lib/activity-route";
import { EmbeddedContext } from "../../web/src/lib/embedded";
import { activityShareUrl } from "../../web/src/lib/emoji-links";
import { haptic } from "../../web/src/lib/haptics";
import {
  hongbaoOf,
  mineOf,
  type PasswordView,
  publicViewOf,
  type Roster,
  rosterOf,
} from "../../web/src/lib/hongbao";
import { liveViewersAtom } from "../../web/src/lib/live-state";
import { useRosterList } from "../../web/src/lib/roster";
import { askSelfClaim } from "../../web/src/lib/self-claim";
import { claimHongbao, HongbaoError, readHongbao, useLive } from "./api";
import type { MiniSdk } from "./sdk";

// 论坛小程序 (docs/mini-app-design.md §7): the 红包 page of 红包站, its own
// parts — the cover that folds small once taken part, its head, numbers and
// 我的结果, 「N 人在看」 — drawn with the forum's data. Only the way to take
// part is the mini app's: the 口令 under the seal (红包站 has its command
// box), and 复制链接 where the forum cannot (代码判定, a human check, a name
// 红包站 cannot take). What leads off the page is left out (lib/embedded.ts).

/** 红包站's origin, for its links (vite.config.ts). */
const SITE = __HB_ORIGIN__;

/**
 * The roster mineOf reads titles from: none (the 名单 is read only once its
 * dialog opens, and 我的结果 should not change when it does).
 */
const noRoster: Roster = { kind: "claims", rows: [] };
const noPasswords: PasswordView = { known: [], hidden: 0, canVerify: false };
const noop = () => {};

/** A payment still on its way: its changes come on the live channel. */
const paying = (payment: ClaimDetail["payment"] | null | undefined) =>
  Boolean(
    payment &&
      ["pending", "sending", "reconciling", "waiting"].includes(payment.status),
  );

/** A submission's id: crypto.randomUUID, or the same from random bytes. */
function submissionId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/** A read with nothing in it, for the hooks before the first one lands. */
const emptyRead = {
  id: "",
  title: "",
  rewardType: "ldc",
  status: "active",
  author: { id: "", username: "", displayName: "", avatarUrl: null },
  forceDedicated: false,
  topicUrl: null,
  openedAt: null,
  deadlineAt: null,
  quantity: { mode: "hidden" },
  beforeInfo: "",
} satisfies MiniHongbaoResponse["activity"];

/** 复制链接: the forum asks first; not copied, the link shows to select. */
function CopyLink({
  sdk,
  url,
  children,
}: {
  sdk: MiniSdk;
  url: string;
  children: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state !== "done") return;
    const timer = window.setTimeout(() => setState("idle"), 1200);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <Squircle radius={radius.card}>
      <div className="hb-note-card mt-2 grid w-full max-w-[26rem] gap-2.5 px-4 py-3 text-left">
        <p className="text-base text-ink">{children}</p>
        {/* Not copied (the forum asks first): the link to select by hand. */}
        {state === "failed" && (
          <p className="text-sm break-all text-ink-2 select-all">{url}</p>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="justify-self-start"
          onClick={() =>
            void sdk.clipboard.writeText(url).then(
              () => setState("done"),
              () => setState("failed"),
            )
          }
        >
          {state === "done" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          <MorphLabel fit={false}>
            {state === "done"
              ? "已复制"
              : state === "failed"
                ? "没能复制，请手动选中链接"
                : "复制链接"}
          </MorphLabel>
        </Button>
      </div>
    </Squircle>
  );
}

/** The address's slash, darker than 红包站's bar has it: on glass. */
function Slash() {
  return <span className="px-0.5 font-medium text-ink-2">/</span>;
}

/**
 * Where 分享 is on 红包站 (page-actions.tsx), across from 「N 人在看」: the
 * 红包's address as 红包站 writes it, /🧧/ and its 表情码, and the copy
 * icon; pressed, it copies that link. The code shrinks until all 14 fit,
 * never below 8px (the address bar's FitCode, its room the row's rather
 * than its own).
 */
function CopyAddress({ sdk, id }: { sdk: MiniSdk; id: string }) {
  const shape = useButtonShape(buttonRadius.sm, buttonHeight.sm);
  const code = activityCode(id);
  const rowRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState(15);
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1200);
    return () => window.clearTimeout(timer);
  }, [state]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const text = codeRef.current;
    const button = buttonRef.current;
    if (!row || !text || !button) return;
    // Its width at 15px, once. The room is the row's less the button's
    // padding, slashes, 🧧 and icon: none of them follow the code.
    text.style.fontSize = "15px";
    const natural = text.scrollWidth;
    const fit = () => {
      const room = row.clientWidth - (button.offsetWidth - text.offsetWidth);
      const next = Math.max(8, Math.min(15, (15 * room) / natural - 0.1));
      text.style.fontSize = `${next}px`;
      setSize(next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const copy = () =>
    void sdk.clipboard.writeText(activityShareUrl(id, SITE)).then(
      () => {
        haptic("light");
        setState("done");
      },
      () => setState("failed"),
    );
  return (
    <div
      className="pointer-events-none sticky top-3 z-20 h-0"
      data-hb-part="actions"
    >
      <div
        ref={rowRef}
        className="absolute top-0 right-3 left-[8.5rem] flex justify-end @wide/window:right-5 @wide/window:left-[9.25rem]"
      >
        {/* 分享's glass; the icon says what pressing it does. */}
        <button
          ref={buttonRef}
          type="button"
          className="btn btn-secondary pointer-events-auto h-9 shrink-0 gap-1.5 px-3 text-sm [&_svg]:size-4"
          style={shape}
          aria-label="复制红包链接"
          title="复制红包链接"
          onClick={copy}
        >
          <SquircleFill radius={buttonRadius.sm} />
          <span aria-hidden="true" className="flex items-center">
            <Slash />
            <span className="font-emoji">{RED_PACKET}</span>
            <Slash />
            <span
              ref={codeRef}
              className="font-emoji whitespace-nowrap"
              style={{ fontSize: size }}
            >
              {code}
            </span>
          </span>
          {state === "done" ? (
            <Check className="text-success" aria-hidden="true" />
          ) : state === "failed" ? (
            <X className="text-danger" aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
        </button>
        <span role="status" className="sr-only">
          {state === "done" ? "已复制" : state === "failed" ? "没能复制" : ""}
        </span>
      </div>
    </div>
  );
}

function Page({
  sdk,
  id,
  reduced,
}: {
  sdk: MiniSdk;
  id: string;
  reduced: boolean;
}) {
  const [data, setData] = useState<MiniHongbaoResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  /** A claim made here, now: the opening plays. */
  const [fresh, setFresh] = useState(false);
  const [typed, setTyped] = useState("");
  /** The seal was pressed on a 口令 红包: its field is out. */
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** 红包站 asked them to sign in there first: why. */
  const [signIn, setSignIn] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  /** The forum's name for them: their own row in the 名单 (for showing). */
  const [forumName, setForumName] = useState<string | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const store = useStore();
  const queryClient = useQueryClient();
  const setViewers = useSetAtom(liveViewersAtom);
  const seq = useRef(0);
  const reading = useRef<Promise<void> | null>(null);
  const readAt = useRef(0);

  const read = useCallback(() => {
    reading.current ??= readHongbao(sdk, id)
      .then((next) => {
        setData(next);
        setFailure(null);
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof HongbaoError
            ? error.code === "ACTIVITY_NOT_FOUND"
              ? "没有找到这个红包，可能已经删除了。"
              : error.message
            : "连不上红包站，请再试一次。",
        );
      })
      .finally(() => {
        reading.current = null;
        readAt.current = Date.now();
      });
    return reading.current;
  }, [sdk, id]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!sdk.permissions.has("user.read")) return;
    sdk.user.getCurrent().then(
      (user) => setForumName(user?.username ?? null),
      () => {},
    );
  }, [sdk]);

  /** Read again, at most once a second however often it is asked. */
  const readSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reread = useCallback(() => {
    if (readSoon.current) return;
    readSoon.current = setTimeout(
      () => {
        readSoon.current = null;
        void read();
      },
      Math.max(0, readAt.current + 1000 - Date.now()),
    );
  }, [read]);

  const activity = data ? hongbaoOf(data.activity) : null;
  const view = publicViewOf(data?.activity ?? emptyRead);
  const mine = data ? mineOf(data.participation, view, noRoster) : null;
  const drawStep = useDrawStep(view);
  const reveal = useDrawMoments(mine, drawStep);

  // 名单, read once its dialog is open, as the 红包 page reads it
  // (use-hongbao-data.ts): a draw's winners once drawn, its sign-ups.
  const draw = data?.activity.reward?.mode === "timed_draw";
  const listed = rosterOpen && data?.activity.status !== "draft";
  const claimsList = useRosterList(id, "claims", {
    enabled:
      Boolean(listed) && (!draw || data?.activity.draw?.state === "completed"),
    viewer: forumName,
    poll: () => false,
  });
  const registrationsList = useRosterList(id, "registrations", {
    enabled: Boolean(listed) && draw,
    viewer: forumName,
    poll: () => false,
  });
  // While it is open the lists follow the numbers above them.
  const counts = data
    ? JSON.stringify([
        data.activity.quantity,
        data.activity.draw,
        data.activity.status,
      ])
    : "";
  const seenCounts = useRef(counts);
  useEffect(() => {
    if (counts === seenCounts.current) return;
    seenCounts.current = counts;
    void queryClient.invalidateQueries({ queryKey: ["activity-roster", id] });
  }, [counts, id, queryClient]);

  useLive(
    sdk,
    id,
    // Running, or over with their payment still on its way.
    Boolean(
      activity &&
        activity.participation !== "code" &&
        (!view.ended || paying(mine?.payment)),
    ),
    (live: MiniLiveMessage) => {
      if (live.type === "mine") return reread();
      // As 红包站's own (lib/live.ts): the number only tells of one missed
      // (read it all again); what each brings is current. A new connection
      // opens with the read and who is watching at the same number.
      const skipped = seq.current > 0 && live.seq > seq.current + 1;
      seq.current = Math.max(seq.current, live.seq);
      if (live.type === "viewers") setViewers({ id, count: live.count });
      else if (live.type === "changed") reread();
      else
        setData((current: MiniHongbaoResponse | null) =>
          current
            ? {
                ...current,
                activity: { ...current.activity, ...live.activity },
              }
            : current,
        );
      if (skipped) reread();
    },
    reread,
  );

  if (!activity)
    return (
      <div className="grid min-h-[60vh] content-center justify-items-center gap-3 px-6 text-center">
        <p className="text-lg text-ink">
          <MorphLabel fit={false}>{failure ?? "正在读取红包…"}</MorphLabel>
        </p>
        {failure && (
          <Button variant="secondary" size="sm" onClick={() => void read()}>
            <RotateCcw aria-hidden="true" />
            再试一次
          </Button>
        )}
      </div>
    );

  const author = data?.author ?? false;
  const seal = sealOf({
    activity,
    view,
    mine,
    standing: null,
    author,
    spinning: claiming,
    gate: null,
    retry: false,
    cooling: false,
    drawStep,
  });
  const elsewhere =
    activity.participation === "code"
      ? "这个红包由判定器判定，要在红包站里领。"
      : activity.humanCheck
        ? "这个红包要先通过人机验证，论坛小程序里加载不了验证，请到红包站领取。"
        : null;
  // Open, but to be taken part in on 红包站: the seal says why, faded.
  const blocked =
    seal.phase === "closed" && !seal.draft
      ? elsewhere
        ? "在论坛里领不了"
        : signIn !== null
          ? "先到红包站登录一次"
          : null
      : null;
  const open =
    seal.phase === "closed" && !seal.draft && !seal.paused && !blocked;
  const password = activity.participation === "password";

  const claim = async () => {
    const typedPassword = typed.trim();
    setClaiming(true);
    setMessage(null);
    try {
      // A first-timer's account is named as the forum says (§7).
      const forumUser =
        !data?.known && sdk.permissions.has("user.read")
          ? await sdk.user.getCurrent().catch(() => null)
          : null;
      const result = await claimHongbao(sdk, id, {
        submissionId: submissionId(),
        ...(password ? { password: typedPassword } : {}),
        ...(forumUser
          ? {
              forumUser: { username: forumUser.username, name: forumUser.name },
            }
          : {}),
      });
      const keep = (
        claimDetail: ClaimDetail | null,
        registration: RegistrationDetail | null,
      ) =>
        setData((current: MiniHongbaoResponse | null) =>
          current
            ? {
                ...current,
                known: true,
                participation: { claim: claimDetail, registration },
              }
            : current,
        );
      if (result.result === "claimed" || result.result === "already_claimed") {
        setFresh(result.result === "claimed");
        keep(result.claim, null);
      } else if (
        result.result === "registered" ||
        result.result === "already_registered"
      ) {
        setFresh(result.result === "registered");
        keep(null, result.registration);
      } else if (result.result === "incorrect")
        setMessage("口令不对，再试一次。");
      else if (result.result === "draft") setMessage("这个红包还没开放。");
      else void read();
    } catch (error) {
      if (error instanceof HongbaoError && error.code === "SIGN_IN_FIRST")
        setSignIn(error.message);
      else
        setMessage(
          error instanceof HongbaoError
            ? error.message
            : "没能领取，请再试一次。",
        );
    } finally {
      setClaiming(false);
    }
  };

  // 自领 (docs/self-claim-design.md): the sender's first share of their own
  // 红包 is asked about first, as on 红包站.
  const send = async () => {
    if (author && !(await askSelfClaim(store, id, seal.isDraw))) return;
    await claim();
  };

  // The seal: a 口令 红包 asks for its 口令 first (on 红包站 the command
  // box opens), then sends it; the others claim at once.
  const press = () => {
    if (!open || claiming) return;
    haptic("light");
    if (password && !asking) {
      setAsking(true);
      return;
    }
    if (password && !typed.trim()) {
      setMessage("先输入口令。");
      field.current?.querySelector("input")?.focus();
      return;
    }
    void send();
  };
  // No <form>: the forum's frame submits none (docs/mini-app-design.md §5),
  // so Enter — not while an input method is composing — and 开 claim.
  const enter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) press();
  };

  // Its kind names the 名单 on the cover (a draw's 报名 or 中奖名单).
  const roster = rosterOf(view, claimsList.rows, registrationsList.rows);
  const hongbao: Hongbao = {
    view,
    roster,
    passwords: noPasswords,
    openVerify: noop,
    openRoster: () => setRosterOpen(true),
    openNote: () => setNoteOpen(true),
    mine,
    standing: null,
    phase: seal.phase,
    fresh,
    reveal,
    // As a page's own claim on 红包站 (no command box to fly back first).
    openDelay: 0.15,
    reduced,
    gate: null,
    author,
    draft: seal.draft,
    isDraw: seal.isDraw,
    glyph: seal.glyph,
    sealState: blocked ? "muted" : seal.sealState,
    sealLabel: blocked ?? seal.sealLabel,
    hint:
      blocked ??
      (open && password && asking && !claiming
        ? `输入口令，再点「${seal.glyph}」`
        : seal.hint),
    drawing: seal.drawing,
    drawStep,
    cooldown: false,
    announcement: seal.announcement,
    press,
    message: null,
  };
  const siteUrl = activityShareUrl(activity.id, SITE);

  const action = (
    <>
      <Reveal show={open && password && asking}>
        <div
          ref={field}
          className="mx-auto mt-2 flex w-[min(22rem,100%)] items-center gap-2"
        >
          <div className="min-w-0 flex-1">
            <TextInput
              aria-label="口令"
              placeholder="口令"
              value={typed}
              invalid={Boolean(message)}
              autoFocus
              onChange={(event) => {
                setTyped(event.target.value);
                setMessage(null);
              }}
              onKeyDown={enter}
            />
          </div>
          <Button
            type="button"
            variant="primary"
            disabled={claiming}
            onClick={press}
          >
            {seal.glyph}
          </Button>
        </div>
      </Reveal>
      {message && <p className="text-sm text-danger">{message}</p>}
      {blocked && elsewhere && (
        <CopyLink sdk={sdk} url={siteUrl}>
          {elsewhere}
        </CopyLink>
      )}
      {blocked && !elsewhere && signIn !== null && (
        <CopyLink sdk={sdk} url={siteUrl}>
          {signIn}
        </CopyLink>
      )}
    </>
  );

  return (
    <div
      className="relative flex flex-col pb-14 [overflow-anchor:none]"
      data-phase={seal.phase}
    >
      <LiveViewers activityId={id} running={!view.ended} />
      <CopyAddress sdk={sdk} id={id} />
      <p className="sr-only" role="status">
        {seal.announcement}
      </p>
      <HongbaoHero activity={activity} hongbao={hongbao} action={action} />
      <WindowDialog
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        labelledBy="note-title"
        width="34rem"
      >
        <NoteContent activity={activity} onClose={() => setNoteOpen(false)} />
      </WindowDialog>
      {/* 名单弹窗: 红包站's, everyone's view of it (the sender's own, with
          口令 and payments, is on 红包站). */}
      <WindowDialog
        open={rosterOpen}
        onClose={() => setRosterOpen(false)}
        labelledBy="roster-title"
        width="30rem"
      >
        <RosterPanel
          data={{
            activity,
            view,
            roster,
            author: false,
          }}
          lists={{
            claims: claimsList.query,
            registrations: registrationsList.query,
          }}
          viewer={forumName}
          onClose={() => setRosterOpen(false)}
        />
      </WindowDialog>
      <SelfClaimDialog />
    </div>
  );
}

/** Opened without a 红包: how to open one. */
function NoHongbao() {
  return (
    <div className="grid min-h-[60vh] content-center justify-items-center gap-2 px-6 text-center">
      <p className="text-lg text-ink">请从红包站分享的小程序链接打开红包。</p>
      <p className="max-w-[26rem] text-sm text-ink-2">
        在红包站的红包页点「分享」，选「论坛小程序」，复制链接发到帖子里，大家点开就能在论坛里领。
      </p>
    </div>
  );
}

type Props = {
  sdk: MiniSdk;
  /** The 红包 the forum link names (`?hb=`), if any. */
  id: string | null;
  reduced: boolean;
};
const PropsContext = createContext<Props | null>(null);

function Root() {
  const props = useContext(PropsContext);
  if (!props) return null;
  return props.id ? (
    <Page sdk={props.sdk} id={props.id} reduced={props.reduced} />
  ) : (
    <NoHongbao />
  );
}

/**
 * The site's parts read the router (links, the 附带网页's 红包): one page
 * in memory, nothing to go to.
 */
export function createMiniRouter() {
  return createRouter({
    routeTree: createRootRoute({ component: Root }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

/** The frame as the 红包 page's window (its sizes, its narrow layout). */
function useFrameInfo(): WindowInfo {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  // The frame grows with the page (up to the forum's limit): a fixed height
  // keeps the cover's size from following it round.
  return useMemo(
    () => ({
      width,
      height: 720,
      compact: width < 640,
      roomy: width >= 960,
      radius: 0,
    }),
    [width],
  );
}

export function App({
  sdk,
  id,
  mode,
  reduced,
  router,
}: Props & {
  mode: "light" | "dark";
  router: ReturnType<typeof createMiniRouter>;
}) {
  const info = useFrameInfo();
  const props = useMemo(() => ({ sdk, id, reduced }), [sdk, id, reduced]);
  // The 名单's lists (lib/roster.ts), read through the forum.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion={reduced ? "always" : "never"}>
        <EmbeddedContext.Provider value={true}>
          <WindowInfoProvider value={info}>
            <PropsContext.Provider value={props}>
              {/* The 红包 page's window: its dialogs and hints are drawn in it. */}
              <div
                data-window-layer
                className="hb-mini relative"
                data-mode={mode}
                data-motion={reduced ? "reduce" : undefined}
                style={sizeVars(hongbaoSizes(info))}
              >
                <RouterProvider router={router} />
              </div>
            </PropsContext.Provider>
          </WindowInfoProvider>
        </EmbeddedContext.Provider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
