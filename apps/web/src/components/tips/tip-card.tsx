import type {
  CreateTipInput,
  PublicTipCard,
  Tip,
  TipMethod,
  TipPaletteColors,
  TipResult,
  TipViewer,
} from "@hb/contracts";
import { TIP_LIMITS, type TipCard } from "@hb/contracts";
import { AnimatePresence, motion } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { RollingNumber } from "../ui/morph-label";
import { radius, Squircle } from "../ui/squircle";
import { tipCardHeight } from "./embed";

// 打赏卡 (docs/tip-design.md §4, §5; mock docs/mocks/tips.html): one card,
// the same on 红包站's ☕ page, in the 社区's mini app and embedded outside.
// It keeps its height whatever step it shows; each step comes in from the
// side it moves to, the last one leaving the other way, both at once.

/** What the card does, wherever it is shown. */
export type TipCardActions = {
  create: (input: CreateTipInput) => Promise<TipResult>;
  check: (tipId: string) => Promise<TipResult>;
  /**
   * How a Credit 站 link reaches the viewer: opened (in a new tab, or
   * through `open` where the page cannot open one itself: the 社区 shows
   * where it goes and asks first), or copied.
   */
  deliver: "copy" | "open";
  copy?: (url: string) => Promise<boolean>;
  open?: (url: string) => Promise<"opened" | "cancelled" | "failed">;
  /** A guest's Cap token for this card (viewer.capEndpoint). */
  capToken?: () => Promise<string>;
};

const LIST_ROWS = TIP_LIMITS.cardListRows;
const MAX_WIDTH = { simple: 460, standard: 500 };

/** A card's preview: as anyone sees it, with no one tipping yet. */
export function previewOf(
  card: Pick<
    TipCard,
    | "code"
    | "version"
    | "active"
    | "style"
    | "palette"
    | "colors"
    | "prompt"
    | "amounts"
    | "defaultIndex"
    | "allowOther"
    | "goal"
    | "tipperCount"
  > & { showRecent?: boolean; showTop?: boolean },
  owner: { username: string; displayName: string; avatarUrl: string | null },
  withLists = true,
) {
  const standard = card.style === "standard";
  return {
    ...card,
    owner,
    recent: withLists && standard && card.showRecent ? [] : null,
    top: withLists && standard && card.showTop ? [] : null,
  };
}

/**
 * A card's colours as styles.css takes them (`.tip-card`): served with the
 * card (tip-design §12); its other tints are worked out from these there.
 */
export function paletteStyle(colors: TipPaletteColors) {
  return {
    "--tp-accent": colors.light.accent,
    "--tp-ink": colors.light.ink,
    "--tp-button": colors.light.button,
    "--tp-dark-accent": colors.dark.accent,
    "--tp-dark-ink": colors.dark.ink,
    "--tp-dark-button": colors.dark.button,
  } as CSSProperties;
}

/** “5”, “2.50”: whole LDC without cents. */
export function ldc(minor: number) {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}
const fixed = (minor: number) => (minor / 100).toFixed(2);

type Step =
  | "idle"
  | "pick"
  | "other"
  | "pay"
  | "msg"
  | "making"
  | "link"
  | "confirm"
  | "sending"
  | "done"
  | "failed";

const ORDER: Record<Step, number> = {
  idle: 0,
  pick: 1,
  other: 2,
  pay: 3,
  msg: 4,
  making: 5,
  link: 6,
  confirm: 6,
  sending: 7,
  done: 8,
  failed: 8,
};

const slide = {
  enter: (direction: number) => ({ opacity: 0, x: 16 * direction }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: -16 * direction }),
};

export function TipCardView({
  card,
  viewer,
  actions,
  onChanged,
  className,
}: {
  card: PublicTipCard;
  /** Null: a preview, nothing to press. */
  viewer: TipViewer | null;
  actions?: TipCardActions;
  /** A tip went through, or the card turned out changed: read it again. */
  onChanged?: () => void;
  className?: string;
}) {
  const reduced = useReducedMotionPref();
  const simple = card.style === "simple";
  const list = !simple && (card.recent !== null || card.top !== null);
  const height = tipCardHeight(card);
  const defaultAmount =
    card.amounts[card.defaultIndex]?.amountMinor ??
    card.amounts[0]?.amountMinor ??
    100;
  const [step, setStep] = useState<Step>("idle");
  const [direction, setDirection] = useState(1);
  const [picked, setPicked] = useState(defaultAmount);
  const [amount, setAmount] = useState(defaultAmount);
  const [other, setOther] = useState("");
  const [message, setMessage] = useState("");
  const [method, setMethod] = useState<TipMethod | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [delivered, setDelivered] = useState(false);
  const [checking, setChecking] = useState(false);
  const [missed, setMissed] = useState(false);
  const [cool, setCool] = useState(0);
  const [armed, setArmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [tab, setTab] = useState<"recent" | "top">(
    card.recent ? "recent" : "top",
  );
  const requestId = useRef(crypto.randomUUID());

  // A changed card (another default, other amounts) starts over.
  const shape = `${card.version}:${defaultAmount}`;
  const seenShape = useRef(shape);
  if (seenShape.current !== shape) {
    seenShape.current = shape;
    if (step === "idle") setPicked(defaultAmount);
  }

  const go = (next: Step, towards?: number) => {
    setDirection(towards ?? (ORDER[next] >= ORDER[step] ? 1 : -1));
    setStep(next);
  };

  const live = viewer !== null && actions !== undefined;
  // Nothing this viewer could pay with: say so on the card, not a row of
  // greyed choices behind 打赏 (a guest when its owner has no LDC 商户).
  const ways = viewer?.methods;
  const nothingToPay =
    ways !== undefined &&
    !ways.checkout.available &&
    !ways.balance &&
    !ways.merchant;
  // Its owner goes through every step as others would, and is stopped only
  // at the last, so what the card offers (no way to pay, say) shows to the
  // one who can fix it (the user, 2026-11-05).
  const own = Boolean(live && viewer.own);
  const blocked = !live
    ? null
    : !card.active
      ? "这张打赏卡已停用"
      : viewer.paused
        ? "打赏暂停"
        : !own && nothingToPay
          ? viewer.methods.checkout.reason === "offline"
            ? "这里暂时不能打赏"
            : "作者还没开通收款，暂时不能打赏"
          : null;

  useEffect(() => {
    if (step !== "confirm") return;
    setArmed(false);
    const timer = window.setTimeout(() => setArmed(true), 500);
    return () => window.clearTimeout(timer);
  }, [step]);

  useEffect(() => {
    if (!cool) return;
    const timer = window.setTimeout(
      () => setCool((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [cool]);

  // While it waits for Credit 站: ask every 10 s, for at most 15 minutes.
  const settleLatest = useRef<(result: TipResult) => boolean>(() => false);
  useEffect(() => {
    if (step !== "link" || !delivered || !tip || !actions) return;
    const until = tip.createdAt + TIP_LIMITS.pollForMs;
    const timer = window.setInterval(() => {
      if (Date.now() > until) return window.clearInterval(timer);
      void actions.check(tip.id).then(
        (result) => settleLatest.current(result),
        () => {},
      );
    }, TIP_LIMITS.pollEveryMs);
    return () => window.clearInterval(timer);
  }, [step, delivered, tip, actions]);

  settleLatest.current = settle;
  function settle(result: TipResult) {
    setTip(result.tip);
    if (result.tip.status === "done") {
      setMine(result.tip.id);
      go("done", 1);
      onChanged?.();
      return true;
    }
    return false;
  }

  function fail(error: unknown) {
    const text =
      error instanceof Error ? error.message : "没有完成，请再试一次。";
    setProblem(text);
    go("failed", 1);
    if ((error as { code?: string }).code === "TIP_CARD_CHANGED") onChanged?.();
  }

  const reset = () => {
    requestId.current = crypto.randomUUID();
    setTip(null);
    setPayUrl(null);
    setDelivered(false);
    setMissed(false);
    setCool(0);
    setMethod(null);
    setMessage("");
    setProblem(null);
    go("idle", -1);
  };

  const startPay = (minor: number) => {
    setAmount(minor);
    requestId.current = crypto.randomUUID();
    go("pay", 1);
  };

  async function make(chosen: TipMethod) {
    if (!actions) return;
    setMethod(chosen);
    // Its owner, at the last step: what others would do here, and no more.
    if (own)
      return fail(
        new Error(
          `这是你自己的打赏卡，不能打赏自己。别人到这一步会${
            chosen === "checkout"
              ? "去 Credit 站付款"
              : chosen === "balance"
                ? "从🐟额转给你"
                : "从他的商户付给你"
          }。`,
        ),
      );
    try {
      const capToken =
        chosen === "checkout" && viewer?.capEndpoint && actions.capToken
          ? await actions.capToken()
          : undefined;
      const result = await actions.create({
        requestId: requestId.current,
        cardVersion: card.version,
        amount: fixed(amount),
        method: chosen,
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(capToken ? { capToken } : {}),
      });
      if (settle(result)) return;
      if (result.payUrl) {
        setPayUrl(result.payUrl);
        go("link", 1);
      } else if (result.tip.status === "sending") go("sending", 1);
      else fail(new Error("Credit 站暂时没有回应，请稍后再试。"));
    } catch (error) {
      fail(error);
    }
  }

  const choose = (chosen: TipMethod) => {
    if (chosen === "checkout") {
      go("making", 1);
      setMethod(chosen);
      void make(chosen);
    } else {
      setMethod(chosen);
      go("confirm", 1);
    }
  };

  const confirm = () => {
    if (!armed || !method) return;
    go(method === "merchant" ? "sending" : "making", 1);
    void make(method);
  };

  async function deliver() {
    if (!payUrl || !actions) return;
    if (actions.deliver === "copy") {
      const copied = (await actions.copy?.(payUrl)) ?? false;
      if (!copied) {
        // Not copied (the 社区 asks first): the link itself, to select.
        setProblem(payUrl);
        return;
      }
    } else if (actions.open) {
      const opened = await actions.open(payUrl);
      // Their own no: as before the press. Not opened: the link, to select.
      if (opened === "cancelled") return;
      if (opened === "failed") {
        setProblem(payUrl);
        return;
      }
    }
    setProblem(null);
    setDelivered(true);
  }

  async function check() {
    if (!tip || !actions || checking || cool) return;
    setChecking(true);
    try {
      const result = await actions.check(tip.id);
      if (!settle(result)) {
        setMissed(true);
        setCool(5);
      }
    } catch {
      setMissed(true);
      setCool(5);
    } finally {
      setChecking(false);
    }
  }

  const owner = card.owner;
  const prompt = card.prompt || `打赏 ${owner.displayName}`;
  const unit = method === "balance" ? "🐟" : "LDC";
  const thanks =
    !list || !card.recent
      ? message.trim()
        ? "谢谢！作者会看到你的留言"
        : "谢谢！"
      : message.trim()
        ? "谢谢！留言会出现在“最近”里"
        : "谢谢！会出现在“最近”里";
  const msgHint = card.recent ? "选填，大家看得到" : "选填，只有作者看得到";

  // ——— pieces ———
  const back = (to: Step) => (
    <button
      type="button"
      aria-label="返回"
      onClick={() => {
        setProblem(null);
        go(to, -1);
      }}
      className="grid size-7 shrink-0 place-items-center rounded-lg text-xl leading-none text-ink-2 hover:bg-[var(--t-soft-2)]"
    >
      ‹
    </button>
  );
  const firstRow = (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar
        name={owner.displayName}
        src={owner.avatarUrl}
        size={simple ? 40 : 36}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold leading-snug">
          {prompt}
        </div>
        {!simple && card.goal && !blocked ? (
          <div className="mt-1 flex items-center gap-1.5">
            <div className="tip-bar flex-1">
              <i
                style={{
                  width: `${Math.min(100, (card.goal.reachedMinor / card.goal.amountMinor) * 100)}%`,
                }}
              />
            </div>
            <span className="shrink-0 text-xs text-ink-3 tabular-nums">
              {ldc(card.goal.reachedMinor)} / {ldc(card.goal.amountMinor)} LDC
            </span>
          </div>
        ) : (
          <div className="truncate text-xs text-ink-3">
            {blocked ??
              (own
                ? "你自己的打赏卡：点开看别人看到的样子"
                : card.tipperCount
                  ? `${card.tipperCount} 人打赏过`
                  : "还没有人打赏")}
          </div>
        )}
      </div>
      {simple ? (
        <Button
          variant="primary"
          size="sm"
          disabled={live && blocked !== null}
          onClick={() => go("pick", 1)}
        >
          打赏
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={live && blocked !== null}
          onClick={() => startPay(picked)}
        >
          打赏 <RollingNumber value={ldc(picked)} /> LDC
        </Button>
      )}
    </div>
  );
  const option = (
    minor: number,
    label: string,
    onPick: () => void,
    pressed?: boolean,
    key?: string,
  ) => (
    <Squircle key={key ?? minor} radius={radius.choice}>
      <button
        type="button"
        disabled={live && blocked !== null}
        aria-pressed={pressed}
        onClick={onPick}
        className="tip-option h-11 flex-1"
      >
        <b
          className={cn(
            "max-w-full truncate font-semibold tabular-nums",
            label ? "text-[13.5px]" : "text-[15px]",
          )}
        >
          {label || ldc(minor)}
        </b>
        <small className="text-[11px] text-ink-3">
          {label ? `${ldc(minor)} LDC` : "LDC"}
        </small>
      </button>
    </Squircle>
  );
  const otherOption = card.allowOther ? (
    <Squircle radius={radius.choice}>
      <button
        type="button"
        disabled={live && blocked !== null}
        onClick={() => go("other", 1)}
        className="tip-option h-11 shrink-0 px-2.5"
      >
        <b className="text-[13.5px] font-semibold">其他</b>
        <small className="text-[11px] text-ink-3">自己填</small>
      </button>
    </Squircle>
  ) : null;
  const options = (
    <div className="flex min-w-0 gap-1.5">
      {card.amounts.map((item, index) =>
        option(
          item.amountMinor,
          item.label,
          () => setPicked(item.amountMinor),
          item.amountMinor === picked,
          `a${index}`,
        ),
      )}
      {otherOption}
    </div>
  );
  const methods = () => {
    const checkout = viewer?.methods.checkout;
    const reasons = own
      ? {
          no_merchant: "你还没配置商户",
          unverified: "商户密钥没通过",
          offline: "这里不能付",
        }
      : {
          no_merchant: "作者没开商户",
          unverified: "暂时不能用",
          offline: "这里不能付",
        };
    const checkoutNote = checkout?.available
      ? "要输密码"
      : reasons[checkout?.reason ?? "offline"];
    if (viewer && !viewer.signedIn)
      return (
        <div className="flex min-w-0 flex-1 gap-2">
          <Squircle radius={radius.choice}>
            <button
              type="button"
              onClick={() => choose("checkout")}
              disabled={!checkout?.available}
              className="tip-option is-first h-11 flex-1 grid-flow-col gap-2"
            >
              <b className="text-sm font-semibold">去 Credit 站付</b>
              <small className="text-[11px] opacity-80">{checkoutNote}</small>
            </button>
          </Squircle>
        </div>
      );
    const items: ReactNode[] = [
      <Squircle key="checkout" radius={radius.choice}>
        <button
          type="button"
          disabled={!checkout?.available}
          onClick={() => choose("checkout")}
          className={cn(
            "tip-option h-11 flex-1",
            checkout?.available && "is-first",
          )}
        >
          <b className="text-sm font-semibold">Credit 站</b>
          <small className="max-w-full truncate text-[11px] opacity-80">
            {checkoutNote}
          </small>
        </button>
      </Squircle>,
    ];
    if (viewer?.methods.merchant)
      items.push(
        <Squircle key="merchant" radius={radius.choice}>
          <button
            type="button"
            onClick={() => choose("merchant")}
            className="tip-option h-11 flex-1"
          >
            <b className="text-sm font-semibold">我的商户</b>
            <small className="text-[11px] text-ink-3">不用输密码</small>
          </button>
        </Squircle>,
      );
    if (viewer?.methods.balance)
      items.push(
        <Squircle key="balance" radius={radius.choice}>
          <button
            type="button"
            onClick={() => choose("balance")}
            className="tip-option h-11 flex-1"
          >
            <b className="text-sm font-semibold">🐟额</b>
            <small className="text-[11px] text-ink-3 tabular-nums">
              可用 {fixed(viewer.methods.balance.availableMinor)}
            </small>
          </button>
        </Squircle>,
      );
    return <div className="flex min-w-0 flex-1 gap-2">{items}</div>;
  };
  const sheen = (text: string) => (
    <Squircle radius={radius.choice}>
      <div className="loading-sheen grid h-10 place-items-center bg-[var(--t-soft-2)] text-[13.5px] font-medium text-[var(--t-ink)]">
        {text}
      </div>
    </Squircle>
  );
  const what = (
    <span className="min-w-0 flex-1 truncate text-sm">
      <b>{ldc(amount)} LDC</b> 打赏给 @{owner.username}
    </span>
  );
  const waitLine = (short: boolean) =>
    checking ? (
      <>
        <span className="tip-dot" />
        正在查…
      </>
    ) : missed ? (
      short ? (
        "还没查到付款"
      ) : (
        "还没查到这笔付款，付完再查一下"
      )
    ) : (
      <>
        <span className="tip-dot" />
        {short
          ? "等你付款…"
          : actions?.deliver === "open"
            ? "等你在新页面付款…"
            : "等你在浏览器里付款…"}
      </>
    );
  const checkButton = (short: boolean) => (
    <Button
      variant={short ? "secondary" : "primary"}
      size="sm"
      className={short ? "shrink-0" : "flex-1"}
      disabled={checking || cool > 0}
      onClick={() => void check()}
    >
      {checking ? (
        "正在查…"
      ) : cool ? (
        <>
          再查一下（
          <RollingNumber value={cool} />）
        </>
      ) : missed ? (
        "再查一下"
      ) : short ? (
        "查一下"
      ) : (
        "我付好了，查一下"
      )}
    </Button>
  );
  const deliverButton = (wide: boolean) => (
    <Button
      variant={delivered ? "secondary" : "primary"}
      size="sm"
      className={wide ? "flex-1" : "shrink-0"}
      onClick={() => {
        // Opened inside the press, so no popup blocker stops it.
        if (actions?.deliver === "open" && !actions.open && payUrl)
          window.open(payUrl, "_blank", "noopener");
        void deliver();
      }}
    >
      {actions?.deliver === "open"
        ? delivered
          ? "再打开"
          : "去 Credit 站付款 ↗"
        : delivered
          ? "再复制"
          : "复制付款链接"}
    </Button>
  );
  const confirmText = () => {
    const amountText = `${fixed(amount)} ${unit}`;
    const merchant = viewer?.methods.merchant?.name ?? "";
    return {
      long:
        method === "balance"
          ? "从你的🐟额转出，不能撤回"
          : `从你的商户「${merchant}」发出，不能撤回`,
      mid:
        method === "balance"
          ? "从你的🐟额转出，不能撤回"
          : "从你的商户发出，不能撤回",
      short: method === "balance" ? "转出去不能撤回" : "发出去不能撤回",
      title: `${amountText} 打赏给 @${owner.username}`,
      titleShort: `${ldc(amount)} ${unit} 给 @${owner.username}`,
    };
  };
  const doneRow = (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[linear-gradient(var(--t-top),var(--t-bottom))] text-lg font-bold text-[var(--t-on)]">
        ✓
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">
          已打赏 {ldc(amount)} {unit}
        </div>
        <div className="truncate text-xs text-ink-3">{thanks}</div>
      </div>
      <button
        type="button"
        onClick={reset}
        className="shrink-0 text-[13px] font-semibold text-[var(--t-ink)]"
      >
        再打赏
      </button>
    </div>
  );
  const failedRow = (to: Step) => (
    <div className="flex min-w-0 items-center gap-2.5">
      {back(to)}
      <span className="min-w-0 flex-1 text-sm text-ink-2">{problem}</span>
    </div>
  );

  // ——— one row (简洁): every step fits in 50px ———
  const oneRow = (): ReactNode => {
    switch (step) {
      case "idle":
        return firstRow;
      case "pick":
        return (
          <div className="flex min-w-0 items-center gap-2">
            {back("idle")}
            <div className="flex min-w-0 flex-1 gap-1.5">
              {card.amounts.map((item, index) =>
                option(
                  item.amountMinor,
                  item.label,
                  () => startPay(item.amountMinor),
                  undefined,
                  `p${index}`,
                ),
              )}
            </div>
          </div>
        );
      case "pay":
        return (
          <div className="flex min-w-0 items-center gap-2">
            {back("pick")}
            <span className="tip-v-wide grid shrink-0 justify-items-center leading-tight">
              <b className="text-[15px] font-semibold tabular-nums">
                {ldc(amount)}
              </b>
              <small className="text-[11px] text-ink-3">LDC</small>
            </span>
            {methods()}
          </div>
        );
      case "making":
      case "sending":
        return (
          <div className="flex min-w-0 items-center gap-2">
            {back("pay")}
            <div className="min-w-0 flex-1">
              {sheen(
                step === "making" ? "正在生成付款链接…" : "正在从你的商户发出…",
              )}
            </div>
          </div>
        );
      case "link":
        return delivered ? (
          <div className="flex min-w-0 items-center gap-2">
            {back("pay")}
            <span className="min-w-0 flex-1 truncate text-sm text-ink-2">
              {waitLine(true)}
            </span>
            {checkButton(true)}
            {deliverButton(false)}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            {back("pay")}
            {problem ? (
              <span className="min-w-0 flex-1 truncate text-xs text-ink-3 select-all">
                {problem}
              </span>
            ) : null}
            {deliverButton(!problem)}
          </div>
        );
      case "confirm": {
        const text = confirmText();
        return (
          <div className="flex min-w-0 items-center gap-2">
            {back("pay")}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">
                <span className="tip-v-wide">{text.title}</span>
                <span className="tip-v-narrow">{text.titleShort}</span>
              </div>
              <div className="truncate text-xs text-ink-3">
                <span className="tip-v-long">{text.long}</span>
                <span className="tip-v-mid">{text.mid}</span>
                <span className="tip-v-short">{text.short}</span>
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={!armed}
              onClick={confirm}
            >
              确认
            </Button>
          </div>
        );
      }
      case "done":
        return doneRow;
      case "failed":
        return failedRow("pay");
      default:
        return null;
    }
  };

  // ——— two rows (标准 without a list): every step fits in 90px ———
  const twoRows = (): ReactNode => {
    switch (step) {
      case "idle":
        return (
          <>
            {firstRow}
            {options}
          </>
        );
      case "other":
        return (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {back("idle")}
              <span className="flex-1 text-[15px] font-semibold">其他数额</span>
              <span className="text-xs text-ink-3">1–2000 LDC</span>
            </div>
            <OtherAmount value={other} onChange={setOther} onDone={startPay} />
          </>
        );
      case "pay":
        return (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {back("idle")}
              {what}
              <button
                type="button"
                onClick={() => go("msg", 1)}
                className="shrink-0 text-[13px] font-semibold text-[var(--t-ink)]"
              >
                {message.trim() ? "留言 ✎" : "＋留言"}
              </button>
            </div>
            {methods()}
          </>
        );
      case "msg":
        return (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {back("pay")}
              <span className="flex-1 text-[15px] font-semibold">留言</span>
              <span className="text-xs text-ink-3">{msgHint}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <TipInput
                value={message}
                onChange={setMessage}
                placeholder="最多 50 个字"
                maxLength={TIP_LIMITS.messageMax}
                onEnter={() => go("pay", -1)}
              />
              <Button variant="primary" size="sm" onClick={() => go("pay", -1)}>
                好
              </Button>
            </div>
          </>
        );
      case "making":
      case "sending":
        return (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {back("pay")}
              {what}
            </div>
            {sheen(
              step === "making" ? "正在生成付款链接…" : "正在从你的商户发出…",
            )}
          </>
        );
      case "link":
        return delivered ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {back("pay")}
              <span className="min-w-0 flex-1 truncate text-sm">
                {waitLine(false)}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              {deliverButton(false)}
              {checkButton(false)}
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {back("pay")}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  problem && "text-ink-2 select-all",
                )}
              >
                {problem ?? "付款链接已生成，几分钟内有效"}
              </span>
            </div>
            <div className="flex min-w-0">{deliverButton(true)}</div>
          </>
        );
      case "confirm": {
        const text = confirmText();
        return (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {back("pay")}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">
                  {text.title}
                </div>
                <div className="truncate text-xs text-ink-3">
                  <span className="tip-v-long">{text.long}</span>
                  <span className="tip-v-mid">{text.mid}</span>
                </div>
              </div>
            </div>
            <div className="flex min-w-0">
              <Button
                variant="primary"
                size="sm"
                className="flex-1"
                disabled={!armed}
                onClick={confirm}
              >
                确认打赏
              </Button>
            </div>
          </>
        );
      }
      case "done":
        return doneRow;
      case "failed":
        return failedRow("pay");
      default:
        return null;
    }
  };

  // ——— the whole card (标准 with a list): the list goes, the step takes its place ———
  const roomy = (): ReactNode => {
    if (step === "idle")
      return (
        <>
          <div className="grid h-[90px] content-center gap-2">
            {firstRow}
            {options}
          </div>
          <TipLists card={card} tab={tab} onTab={setTab} mine={mine} />
        </>
      );
    if (step === "done")
      return (
        <div className="grid h-full content-center justify-items-center gap-1.5 text-center">
          <span className="mb-1 grid size-12 place-items-center rounded-full bg-[linear-gradient(var(--t-top),var(--t-bottom))] text-2xl font-bold text-[var(--t-on)]">
            ✓
          </span>
          <div className="text-base font-semibold">
            已打赏 {ldc(amount)} {unit}
          </div>
          <div className="text-xs text-ink-3">{thanks}</div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={reset}
          >
            再打赏
          </Button>
        </div>
      );
    const amountBlock = (
      <div>
        <div className="text-[30px] font-bold leading-tight tabular-nums">
          {ldc(amount)}{" "}
          <small className="text-sm font-semibold text-ink-3">
            {unit === "🐟" && step === "confirm" ? "🐟" : "LDC"}
          </small>
        </div>
        <div className="text-sm text-ink-2">打赏给 @{owner.username}</div>
      </div>
    );
    let body: ReactNode = null;
    let backTo: Step = "pay";
    if (step === "other") {
      backTo = "idle";
      body = (
        <>
          <div className="text-[15px] font-semibold">其他数额</div>
          <OtherAmount value={other} onChange={setOther} onDone={startPay} />
          <div className="text-xs text-ink-3">1–2000 LDC</div>
        </>
      );
    } else if (step === "pay") {
      backTo = "idle";
      body = (
        <>
          {amountBlock}
          <TipInput
            value={message}
            onChange={setMessage}
            placeholder={`留言（${msgHint}）`}
            maxLength={TIP_LIMITS.messageMax}
          />
          {methods()}
        </>
      );
    } else if (step === "making" || step === "sending")
      body = (
        <>
          {amountBlock}
          {sheen(
            step === "making" ? "正在生成付款链接…" : "正在从你的商户发出…",
          )}
        </>
      );
    else if (step === "link")
      body = delivered ? (
        <>
          {amountBlock}
          <div className="text-sm">{waitLine(false)}</div>
          <div className="flex gap-2">
            {deliverButton(false)}
            {checkButton(false)}
          </div>
          <div className="text-xs text-ink-3">
            付完这里会自己变；没变就按“查一下”。
          </div>
        </>
      ) : (
        <>
          {amountBlock}
          <div className="flex">{deliverButton(true)}</div>
          <div
            className={cn(
              "text-xs text-ink-3",
              problem && "break-all select-all",
            )}
          >
            {problem ??
              (actions?.deliver === "open"
                ? "在新页面里输入 Credit 站的安全密码付款。链接几分钟内有效，过期了回来重新生成。"
                : "复制的是 Credit 站的付款页，在浏览器里打开，输入安全密码付款。几分钟内有效，过期了回来重新生成。")}
          </div>
        </>
      );
    else if (step === "confirm") {
      const text = confirmText();
      body = (
        <>
          {amountBlock}
          <div className="text-xs text-ink-3">
            <span className="tip-v-long">{text.long}</span>
            <span className="tip-v-mid">{text.mid}</span>
          </div>
          <div className="flex">
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              disabled={!armed}
              onClick={confirm}
            >
              确认打赏
            </Button>
          </div>
        </>
      );
    } else if (step === "failed")
      body = <div className="text-sm text-ink-2">{problem}</div>;
    return (
      <div className="grid h-full grid-rows-[auto_1fr] gap-1.5">
        <div className="flex">{back(backTo)}</div>
        <div className="grid min-w-0 content-center gap-2.5 pb-7">{body}</div>
      </div>
    );
  };

  const content = simple ? oneRow() : list ? roomy() : twoRows();
  const inner = height - 26;
  return (
    <Squircle radius={radius.pop}>
      <div
        // A preview looks as it will, and takes nothing.
        inert={!live || undefined}
        className={cn("tip-card px-3.5 py-3", className)}
        data-style={card.style}
        style={{
          ...paletteStyle(card.colors),
          height,
          maxWidth: MAX_WIDTH[card.style],
        }}
      >
        <div className="relative" style={{ height: inner }}>
          <AnimatePresence initial={false} custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={slide}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{
                duration: reduced ? 0 : 0.32,
                ease,
                opacity: { duration: reduced ? 0 : 0.24, ease },
              }}
              className={cn(
                "absolute inset-0 grid min-w-0 gap-2",
                !list || step !== "idle" ? "content-center" : "content-start",
              )}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Squircle>
  );
}

function TipInput({
  value,
  onChange,
  placeholder,
  maxLength,
  onEnter,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength: number;
  onEnter?: () => void;
}) {
  return (
    <Squircle radius={radius.input}>
      <input
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing)
            onEnter?.();
        }}
        className="h-10 min-w-0 flex-1 bg-white px-3 text-[15px] text-ink shadow-[inset_0_0_0_1px_var(--t-line)] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_2px_var(--t-accent)]"
      />
    </Squircle>
  );
}

function OtherAmount({
  value,
  onChange,
  onDone,
}: {
  value: string;
  onChange: (value: string) => void;
  onDone: (minor: number) => void;
}) {
  const parsed = /^\d{1,4}(\.\d{1,2})?$/.test(value.trim())
    ? Math.round(Number(value.trim()) * 100)
    : null;
  const ok =
    parsed !== null &&
    parsed >= TIP_LIMITS.amountMinMinor &&
    parsed <= TIP_LIMITS.amountMaxMinor;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TipInput
        value={value}
        onChange={onChange}
        placeholder="多少 LDC"
        maxLength={7}
        onEnter={() => ok && onDone(parsed)}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={!ok}
        onClick={() => ok && onDone(parsed)}
      >
        下一步
      </Button>
    </div>
  );
}

function amountTier(minor: number) {
  return minor >= 2000
    ? "tip-amount-tier-3"
    : minor >= 1000
      ? "tip-amount-tier-2"
      : "text-ink-2";
}

function TipLists({
  card,
  tab,
  onTab,
  mine,
}: {
  card: PublicTipCard;
  tab: "recent" | "top";
  onTab: (tab: "recent" | "top") => void;
  mine: string | null;
}) {
  const both = card.recent !== null && card.top !== null;
  const shown = both ? tab : card.recent ? "recent" : "top";
  const recent = (card.recent ?? []).slice(0, LIST_ROWS);
  const top = (card.top ?? []).slice(0, LIST_ROWS);
  const empty = shown === "recent" ? recent.length === 0 : top.length === 0;
  return (
    <div className="grid min-w-0 gap-2 pt-2">
      <div className="flex h-6 min-w-0 items-center gap-2">
        {both ? (
          <span className="inline-flex shrink-0 gap-0.5 rounded-[10px] bg-[color-mix(in_srgb,var(--t-accent)_10%,transparent)] p-0.5">
            {(["recent", "top"] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={shown === key}
                onClick={() => onTab(key)}
                className={cn(
                  "rounded-lg px-2.5 py-0.5 text-[12.5px] transition-colors",
                  shown === key
                    ? "bg-white font-semibold text-ink"
                    : "text-ink-2",
                )}
              >
                {key === "recent" ? "最近" : "总榜"}
              </button>
            ))}
          </span>
        ) : (
          <span className="shrink-0 text-[12.5px] font-semibold text-ink-2">
            {shown === "recent" ? "最近打赏" : "总榜"}
          </span>
        )}
        <span className="flex-1" />
        <span className="truncate text-xs text-ink-3">
          这张卡 · {card.tipperCount} 人
        </span>
      </div>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={shown}
          initial={{ opacity: 0, x: shown === "top" ? 12 : -12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: shown === "top" ? -12 : 12 }}
          transition={{ duration: 0.2, ease }}
          className="grid min-w-0 gap-0.5"
        >
          {empty ? (
            <div className="grid h-[142px] place-items-center text-sm text-ink-3">
              还没有人打赏，来做第一个吧
            </div>
          ) : shown === "recent" ? (
            recent.map((row) => (
              <div
                key={row.id}
                className={cn(
                  "flex h-[34px] min-w-0 items-center gap-2 rounded-[10px] px-1 text-[13.5px]",
                  row.id === mine && "tip-mine",
                )}
              >
                <span className="max-w-[30%] shrink-0 truncate font-semibold">
                  {row.person ? row.person.displayName : "游客"}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {row.messageHidden ? "留言已隐藏" : row.message}
                </span>
                <span className="shrink-0 text-xs text-ink-3">
                  {ago(row.at)}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-lg px-2 py-0.5 font-semibold tabular-nums",
                    amountTier(row.amountMinor),
                  )}
                >
                  {ldc(row.amountMinor)}
                  {row.method === "balance" ? " 🐟" : ""}
                </span>
              </div>
            ))
          ) : (
            top.map((row) => (
              <div
                key={row.person.username}
                className="flex h-[34px] min-w-0 items-center gap-2 px-1 text-[13.5px]"
              >
                <span className="w-5 shrink-0 text-center font-bold text-ink-3 tabular-nums">
                  {row.rank}
                </span>
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {row.person.displayName}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-lg px-2 py-0.5 font-semibold tabular-nums",
                    amountTier(row.amountMinor),
                  )}
                >
                  {ldc(row.amountMinor)}
                </span>
              </div>
            ))
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** “刚刚”, “3 分钟前”, “2 小时前”, “昨天”, “5 天前”. */
function ago(at: number) {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 2 * 86_400) return "昨天";
  return `${Math.floor(seconds / 86_400)} 天前`;
}
