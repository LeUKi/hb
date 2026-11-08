import { FORUM_FRAME_MIN, type Tip, type TipCard } from "@hb/contracts";
import { RotateCcw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { tipCardHeight, tipForumEmbed } from "@/components/tips/embed";
import {
  ldc,
  previewOf,
  type TipCardActions,
  TipCardView,
} from "@/components/tips/tip-card";
import { Button } from "@/components/ui/button";
import {
  checkTip,
  createTip,
  HongbaoError,
  type MiniTipsHome,
  type MiniTipView,
  readTip,
  readTipsHome,
} from "./api";
import { OpenLink } from "./open-link";
import type { MiniSdk } from "./sdk";

// 打赏 in the 社区 (docs/tip-design.md §5, §7): a card (`?tip=<卡号>`), and
// the app's home, one's own cards. Everyone here is known by the 社区:
// someone not signed in sees no card, only that they need to sign in.

const SITE = __HB_ORIGIN__;

/** Not signed in to the 社区: nothing of the card, only what to do. */
function SignInForTips() {
  return (
    <div className="mx-auto grid min-h-[76px] max-w-[460px] content-center justify-items-center gap-1 rounded-[22px] border border-dashed border-line px-4 py-3 text-center">
      <b className="text-[14.5px] font-semibold text-ink">
        登录社区后才能使用小程序
      </b>
      <span className="text-xs text-ink-3">登录以后刷新这一页就能看到</span>
    </div>
  );
}

/**
 * Not read: why, and 再试一次 unless trying again cannot help. Card-sized,
 * so it fits a 简洁 card's embed (2026-11-05: a timeout left only words).
 */
function Problem({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <div className="mx-auto grid min-h-[76px] max-w-[460px] content-center justify-items-center gap-1.5 px-4 py-2 text-center">
      <p className="text-sm text-ink-2">{text}</p>
      {retry && (
        <Button variant="secondary" size="sm" onClick={retry}>
          <RotateCcw aria-hidden="true" />
          再试一次
        </Button>
      )}
    </div>
  );
}

async function copy(sdk: MiniSdk, text: string) {
  try {
    await sdk.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The 社区 shows at least 320 under its bar (FORUM_FRAME_MIN), however
 * short the card: the page fills that, so no strip of the 社区's own
 * colour shows under it; whatever is shown sits at the top, the room
 * under it left empty (the user, 2026-11-05: centred looked odd).
 */
function InFrame({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: FORUM_FRAME_MIN }}>{children}</div>;
}

/** A 打赏卡 embedded in a post or in 关于我. */
export function TipScreen({ sdk, code }: { sdk: MiniSdk; code: string }) {
  const [guest, setGuest] = useState<boolean | null>(null);
  const [view, setView] = useState<MiniTipView | null>(null);
  const [problem, setProblem] = useState<{
    text: string;
    gone: boolean;
  } | null>(null);
  const load = useCallback(() => {
    setProblem(null);
    return readTip(sdk, code).then(setView, (error: unknown) => {
      const gone = error instanceof HongbaoError && error.status === 404;
      setProblem({
        text: gone
          ? "这张打赏卡不在了。"
          : error instanceof Error
            ? error.message
            : "打赏卡没有读出来。",
        gone,
      });
    });
  }, [sdk, code]);
  useEffect(() => {
    void sdk.user.getCurrent().then(
      (user) => {
        setGuest(user === null);
        if (user) void load();
      },
      () => setGuest(true),
    );
  }, [sdk, load]);
  const actions = useMemo<TipCardActions>(
    () => ({
      deliver: "copy",
      copy: (url) => copy(sdk, url),
      create: async (input) => {
        if (view?.lookOnly)
          throw new HongbaoError(
            403,
            "LOOK_ONLY",
            "沙箱里只能看，正式版上线后才能打赏。",
          );
        const user = await sdk.user.getCurrent().catch(() => null);
        return createTip(sdk, code, {
          ...input,
          ...(user
            ? { forumUser: { username: user.username, name: user.name } }
            : {}),
        });
      },
      check: (tipId) => checkTip(sdk, code, tipId),
    }),
    [sdk, code, view?.lookOnly],
  );
  if (guest)
    return (
      <InFrame>
        <div className="p-2">
          <SignInForTips />
        </div>
      </InFrame>
    );
  if (problem)
    return (
      <InFrame>
        <Problem
          text={problem.text}
          retry={problem.gone ? undefined : () => void load()}
        />
      </InFrame>
    );
  if (!view)
    return (
      <InFrame>
        <div className="p-2">
          <div className="loading-sheen mx-auto h-[76px] max-w-[460px] rounded-[22px] bg-fill" />
        </div>
      </InFrame>
    );
  // 6 at the sides: a card at its narrowest (288) fills the 300 of 关于我
  // without scrolling; 8 above and below, as 红包站's embed code allows
  // for (tipForumEmbed, 2026-11-05).
  return (
    <InFrame>
      <div className="overflow-x-auto px-1.5 py-2">
        <TipCardView
          card={view.card}
          viewer={view.viewer}
          actions={actions}
          onChanged={() => void load()}
        />
      </div>
    </InFrame>
  );
}

const styleName = { simple: "简洁", standard: "标准" } as const;

/**
 * The app's home: one's own cards, each opening to its last tips; under
 * them, `children` (how to open a 红包). Not signed in to the 社区: only
 * `guest`.
 */
export function TipsHome({
  sdk,
  guest: guestView,
  children,
}: {
  sdk: MiniSdk;
  guest: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [home, setHome] = useState<MiniTipsHome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [guest, setGuest] = useState(false);
  const load = useCallback(() => {
    setProblem(null);
    return readTipsHome(sdk).then(setHome, (error: unknown) =>
      setProblem(error instanceof Error ? error.message : "没有读出来。"),
    );
  }, [sdk]);
  useEffect(() => {
    void sdk.user.getCurrent().then(
      (user) => {
        // Not signed in to the 社区: no cards to show, only the 红包 note.
        if (!user) return setGuest(true);
        void load();
      },
      () => setGuest(true),
    );
  }, [sdk, load]);
  if (guest) return <>{guestView}</>;
  const card = home?.cards.find((item) => item.code === open) ?? null;
  return (
    <div className="mx-auto grid max-w-[36rem] gap-3 px-4 pt-6 pb-4">
      {problem ? (
        <Problem text={problem} retry={() => void load()} />
      ) : !home ? (
        <div className="loading-sheen h-40 rounded-[22px] bg-fill" />
      ) : card ? (
        <CardDetail
          sdk={sdk}
          card={card}
          recent={home.recent[card.code] ?? []}
          onBack={() => setOpen(null)}
        />
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <b className="text-base text-ink">我的打赏</b>
            {home.week && (
              <span className="text-xs text-ink-3">
                近 7 天 {home.week.count} 次 · {ldc(home.week.amountMinor)} LDC
              </span>
            )}
          </div>
          {home.cards.length === 0 ? (
            <div className="grid gap-2 rounded-[18px] border border-line p-4 text-sm text-ink-2">
              <p>
                还没有打赏卡。到红包站的“我的打赏”里新建一张，复制嵌入代码贴进帖子末尾或个人页的“关于我”，别人点一下就能打赏你。
              </p>
              <OpenLink
                sdk={sdk}
                url={`${SITE}/tips`}
                label="打开红包站的我的打赏"
              />
            </div>
          ) : (
            <ul className="grid gap-2">
              {home.cards.map((item) => (
                <li key={item.code}>
                  <button
                    type="button"
                    onClick={() => setOpen(item.code)}
                    className="flex w-full items-center gap-3 rounded-[16px] border border-line px-3.5 py-2.5 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <b className="block truncate font-semibold text-ink">
                        {item.name}
                      </b>
                      <span className="block truncate text-xs text-ink-3">
                        {styleName[item.style]}
                        {item.goal ? " · 目标" : ""}
                        {item.active ? "" : " · 已停用"} · 近 7 天{" "}
                        {item.week.count} 次
                      </span>
                    </span>
                    <span className="text-ink-3">›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-3">
            新建、编辑到红包站的“我的打赏”里。
          </p>
          {children}
        </>
      )}
    </div>
  );
}

function CopyButton({
  sdk,
  text,
  label,
}: {
  sdk: MiniSdk;
  text: string;
  label: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <Button
      variant="secondary"
      size="sm"
      className="justify-self-start"
      onClick={() =>
        void copy(sdk, text).then((done) => {
          setState(done ? "done" : "failed");
          window.setTimeout(() => setState("idle"), 1600);
        })
      }
    >
      {state === "done" ? "已复制" : state === "failed" ? "没复制上" : label}
    </Button>
  );
}

/** One card, from the home: back to 我的打赏 at the top left. */
function CardDetail({
  sdk,
  card,
  recent,
  onBack,
}: {
  sdk: MiniSdk;
  card: TipCard;
  /** Its last tips, newest first (红包站 sends a few). */
  recent: Tip[];
  onBack: () => void;
}) {
  const [owner, setOwner] = useState({
    username: "",
    displayName: "",
    avatarUrl: null as string | null,
  });
  useEffect(() => {
    void sdk.user.getCurrent().then((user) => {
      if (user)
        setOwner({
          username: user.username,
          displayName: user.name || user.username,
          avatarUrl: user.avatarUrl ?? null,
        });
    });
  }, [sdk]);
  const preview = previewOf(card, owner);
  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={onBack}
        className="justify-self-start text-sm text-ink-2"
      >
        ‹ 我的打赏
      </button>
      <div className="flex items-baseline justify-between gap-3">
        <b className="truncate text-base text-ink">{card.name}</b>
        <span className="shrink-0 text-xs text-ink-3">
          {styleName[card.style]}
          {card.goal ? ` · 目标 ${ldc(card.goal.amountMinor)} LDC` : ""}
        </span>
      </div>
      <div className="overflow-x-auto">
        <TipCardView card={preview} viewer={null} />
      </div>
      <CopyButton
        sdk={sdk}
        text={tipForumEmbed(
          card.code,
          owner.displayName || owner.username,
          tipCardHeight(preview),
        )}
        label="复制嵌入代码"
      />
      <div className="flex items-baseline justify-between gap-3 text-xs text-ink-3">
        <span>最近收到的</span>
        <span>
          近 7 天 {card.week.count} 次 · {ldc(card.week.amountMinor)} LDC
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="text-sm text-ink-3">还没有人打赏过这张卡。</p>
      ) : (
        <ul className="grid gap-1">
          {recent.map((tip) => (
            <li key={tip.id} className="flex items-center gap-2 text-sm">
              <span className="max-w-[35%] shrink-0 truncate font-semibold">
                {tip.counterpart?.displayName ?? "游客"}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-2">
                {tip.messageHidden ? "留言已隐藏" : tip.message}
              </span>
              <span className="shrink-0 font-semibold tabular-nums">
                {ldc(tip.amountMinor)} {tip.method === "balance" ? "🐟" : "LDC"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
