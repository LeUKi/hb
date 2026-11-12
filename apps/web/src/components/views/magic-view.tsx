import type { MiniMagic } from "@hb/contracts";
import { MINI_HOP_PATH } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { getLoginHref, useLogout } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { useMagic } from "../../lib/magic";
import { useIdentity } from "../../lib/session";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { PageLoad, PageSkeleton, queryLoad } from "../page/page-state";
import { BrandMark } from "../shell/brand-mark";
import { usePageTitle } from "../shell/use-page-title";
import { Button } from "../ui/button";
import { LinuxDoMark } from "../ui/linux-do-mark";
import { MorphLabel, RollingNumber } from "../ui/morph-label";
import { Squircle } from "../ui/squircle";
import { IdentityFailedView } from "./message-view";

// /magic (docs/mini-app-design.md §8): the one address the 社区's mini app
// opens. The app tells 红包站 first where it wants to go; this page shows
// whoever is signed in what that is and opens it after a short countdown.
// Every other case says why not and what to do: signed out, too long ago,
// nothing asked (or a different account here). Its own face, not a bare
// 提示页 (the user: “404 有点丑”): the way from the 社区 to 红包站 drawn on
// top, the words kept short and narrow, the page centred in the window.

const TITLE = "打开社区里点的页面";
/** Seconds before it opens by itself. */
const COUNTDOWN = 3;

type Hop = NonNullable<MiniMagic["hop"]>;

/** What it is, as a sentence starts it. */
function whatOf(hop: Hop) {
  switch (hop.kind) {
    case "hongbao":
      return hop.title ? `红包「${hop.title}」` : "社区里点的红包";
    case "points":
      return hop.title ? `「${hop.title}」的详情页` : "三方积分的详情页";
    case "tips":
      return "你的打赏卡和收到的打赏";
    case "credit":
      return "打赏的付款页在 credit.linux.do，几分钟内有效";
    case "page":
      return `红包站的 ${decodeURI(hop.to)}`;
  }
}

/** The page's title; “即将” while it counts down. */
const titleOf: Record<Hop["kind"], string> = {
  hongbao: "打开红包",
  points: "打开积分详情",
  tips: "打开我的打赏",
  credit: "前往 Credit 站付款",
  page: "打开红包站的页面",
};

/** How long ago, in the page's words. */
function agoOf(at: number) {
  const minutes = Math.max(1, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** Goes there, in place of this page (back skips it); once. */
function useOpen() {
  const navigate = useNavigate();
  const gone = useRef(false);
  return useCallback(
    (hop: Hop) => {
      if (gone.current) return;
      gone.current = true;
      if (hop.kind === "credit") window.location.replace(hop.to);
      else void navigate({ href: hop.to, replace: true });
    },
    [navigate],
  );
}

/**
 * The way from the 社区 to 红包站: LINUX DO's mark, a track, 红包站's.
 * While it counts down the track carries the loading sheen; where nothing
 * goes through, it is faint.
 */
function Route({ state }: { state: "moving" | "still" | "broken" }) {
  return (
    <div aria-hidden="true" className="flex items-center gap-3">
      <Squircle radius={17}>
        <span className="grid size-14 place-items-center bg-white/80 shadow-[inset_0_1px_0_rgb(255_255_255/0.9)]">
          <LinuxDoMark className="size-8" />
        </span>
      </Squircle>
      <span
        className={cn(
          "flex items-center text-ink-3",
          state === "broken" && "opacity-40",
        )}
      >
        <span
          className={cn(
            "h-1 w-12 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-ink-3)_35%,transparent)]",
            state === "moving" && "loading-sheen loading-sheen-gold",
          )}
        />
        <ChevronRight className="-ml-1.5 size-5" />
      </span>
      <BrandMark size={56} />
    </div>
  );
}

/** The page's one layout: the way, a title, a sentence or two, actions. */
function MagicLayout({
  route,
  title,
  text,
  note,
  actions,
}: {
  route: "moving" | "still" | "broken";
  title: string;
  text: ReactNode;
  note?: string;
  actions: ReactNode;
}) {
  usePageTitle(title);
  return (
    // Centred in what the window shows under its bar.
    <div className="flex min-h-[calc(100cqh-var(--bar-h))] flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      <Route state={route} />
      <div className="grid max-w-[26rem] justify-items-center gap-2">
        {/* Focusable from code: where reading starts again after 重试. */}
        <h1
          tabIndex={-1}
          className="text-xl font-semibold text-ink outline-none"
        >
          {title}
        </h1>
        {/* Lines break at the punctuation, inside a word only when one
            would not fit (a long 红包 title on a phone). */}
        <p className="text-base break-keep text-ink-2 [overflow-wrap:anywhere]">
          {text}
        </p>
        {note && (
          <p className="text-sm break-keep text-ink-3 [overflow-wrap:anywhere]">
            {note}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-center gap-2">{actions}</div>
    </div>
  );
}

function HomeButton() {
  const { goHome } = useOmniboxController();
  return <Button onClick={goHome}>回到首页</Button>;
}

export function MagicView() {
  const identity = useIdentity();
  const query = useMagic(identity.user?.id ?? null);
  if (!identity.ready) return <PageSkeleton />;
  if (identity.failed) return <IdentityFailedView title={TITLE} />;
  if (!identity.user) return <SignInFirst />;
  const username = identity.user.username;
  return (
    <PageLoad load={queryLoad(query)}>
      {query.data &&
        (query.data.hop === null ? (
          <NothingAsked username={username} csrf={identity.csrfToken} />
        ) : query.data.hop.fresh ? (
          <Countdown key={query.data.hop.at} hop={query.data.hop} />
        ) : (
          <TooLate hop={query.data.hop} />
        ))}
    </PageLoad>
  );
}

/** Signed out: who they are is 红包站's sign-in, then back here. */
function SignInFirst() {
  return (
    <MagicLayout
      route="still"
      title="登录后接着打开"
      text="你在社区小程序里点了打开。登录红包站后，会接着打开刚才的页面。"
      note="用 LINUX DO 登录，和社区是同一个账号。"
      actions={
        <>
          <Button
            variant="primary"
            onClick={() => window.location.assign(getLoginHref(MINI_HOP_PATH))}
          >
            用 LINUX DO 登录
          </Button>
          <HomeButton />
        </>
      }
    />
  );
}

/** Asked within the last ten minutes: opens after COUNTDOWN seconds. */
function Countdown({ hop }: { hop: Hop }) {
  const open = useOpen();
  const [left, setLeft] = useState(COUNTDOWN);
  const [running, setRunning] = useState(true);
  const openButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!running) return;
    if (left <= 0) {
      open(hop);
      return;
    }
    const timer = window.setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [running, left, hop, open]);
  // Credit 站 is another site: 前往 rather than 打开.
  const verb = hop.kind === "credit" ? "前往" : "打开";
  return (
    <MagicLayout
      route={running ? "moving" : "still"}
      title={running ? `即将${titleOf[hop.kind]}` : titleOf[hop.kind]}
      text={
        running ? (
          <>
            {whatOf(hop)}，<RollingNumber value={Math.max(left, 0)} /> 秒后自动
            {verb}。
          </>
        ) : (
          `${whatOf(hop)}。已停下，需要时点“${verb}”。`
        )
      }
      actions={
        <>
          <Button ref={openButton} variant="primary" onClick={() => open(hop)}>
            <MorphLabel fit={false}>
              {running ? `现在${verb}` : verb}
            </MorphLabel>
          </Button>
          {running ? (
            <Button
              onClick={() => {
                setRunning(false);
                // The button goes: focus to the one that opens it now.
                openButton.current?.focus();
              }}
            >
              先不{verb}
            </Button>
          ) : (
            <HomeButton />
          )}
        </>
      }
    />
  );
}

/** Asked longer ago: never by itself; a payment page is gone by now. */
function TooLate({ hop }: { hop: Hop }) {
  const open = useOpen();
  if (hop.kind === "credit")
    return (
      <MagicLayout
        route="broken"
        title="付款页已经失效"
        text="Credit 站的付款页只在几分钟内有效。"
        note="回到社区小程序里的打赏卡，再点一次“去 Credit 站付款”。"
        actions={<HomeButton />}
      />
    );
  return (
    <MagicLayout
      route="still"
      title="这次打开已经过时"
      text={`${whatOf(hop)}，是 ${agoOf(hop.at)}在社区小程序里点的。`}
      note="超过 10 分钟就不再自动打开。还要的话点“仍然打开”，或者回社区再点一次。"
      actions={
        <>
          <Button variant="primary" onClick={() => open(hop)}>
            仍然打开
          </Button>
          <HomeButton />
        </>
      }
    />
  );
}

/**
 * Nothing asked by this account: opened by hand, or 红包站 is signed in
 * with another account than the 社区's.
 */
function NothingAsked({
  username,
  csrf,
}: {
  username: string;
  csrf: string | null;
}) {
  const logout = useLogout(csrf);
  return (
    <MagicLayout
      route="broken"
      title="没有要打开的页面"
      text="社区小程序打开红包站时，会经过这里。"
      note={`刚在社区点过的话，可能这里登录的 @${username}，不是社区里那个账号。`}
      actions={
        <>
          <HomeButton />
          <Button
            aria-disabled={logout.isPending || undefined}
            onClick={() => {
              if (logout.isPending) return;
              logout.mutate(undefined, {
                onSuccess: () =>
                  window.location.assign(getLoginHref(MINI_HOP_PATH)),
              });
            }}
          >
            <MorphLabel fit={false}>
              {logout.isPending
                ? "正在退出…"
                : logout.isError
                  ? "退出没有完成，再试一次"
                  : "换个账号登录"}
            </MorphLabel>
          </Button>
        </>
      }
    />
  );
}
