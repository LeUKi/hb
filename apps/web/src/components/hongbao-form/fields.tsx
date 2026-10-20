import { ACTIVITY_LIMITS } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronRight,
  Equal,
  KeyRound,
  ListOrdered,
  Lock,
  Plus,
  Shuffle,
  Sparkles,
  Store,
  Timer,
  Trash2,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { useBalanceFunding } from "../../lib/balance";
import { cn } from "../../lib/cn";
import { splitNames, splitRules } from "../../lib/hongbao-text";
import { useCurrentMerchant, useMerchant } from "../../lib/merchants";
import { scrollBehavior } from "../../lib/motion";
import { inspectPassword, optimizePassword } from "../../lib/password-rules";
import { useSessionUser } from "../../lib/session";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Callout } from "../page/page";
import { Button } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import {
  ChoiceCards,
  Field,
  Segmented,
  TextArea,
  TextInput,
  WrapInput,
} from "../ui/field";
import { Reveal, RevealInline, Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import {
  type Algorithm,
  customLines,
  type FormState,
  type Issue,
  LIMITS,
  ldc,
  plan,
  type RewardMode,
  type TimeUnit,
  unitLabels,
} from "./form-state";

/**
 * Credit's smallest daily limit, 800 LDC in cents (its lowest pay level): a
 * bigger 红包 may not be paid out in one day (api: payments/quota.ts).
 */
const DAILY_LIMIT_FLOOR = 80_000;

// The 发红包 flow's controls, shared by its steps and the 更多设置 panel.

export type Update = (change: (form: FormState) => FormState) => void;
export type ErrorOf = (field: string) => string | undefined;

/** A note that a field cannot change any more, with the reason. */
export function LockNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-ink-3">
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

export function counter(text: string, max: number) {
  const length = Array.from(text).length;
  return (
    <span className={length > max ? "text-danger" : undefined}>
      {length.toLocaleString("en")} / {max.toLocaleString("en")}
    </span>
  );
}

/**
 * The 玩法: the two most used first (拼手气, 限时开奖); the other two wait
 * behind 更多玩法.
 */
export const modeOptions: {
  value: RewardMode;
  title: string;
  description: string;
  icon: typeof Equal;
  more?: boolean;
}[] = [
  {
    value: "random",
    title: "拼手气",
    description: "总额随机分成几份",
    icon: Shuffle,
  },
  {
    value: "timed_draw",
    title: "限时开奖",
    description: "先报名，到时抽奖",
    icon: Timer,
  },
  {
    value: "fixed",
    title: "固定均分",
    description: "每人金额一样",
    icon: Equal,
    more: true,
  },
  {
    value: "custom",
    title: "自定义金额",
    description: "一行一份，自己定",
    icon: ListOrdered,
    more: true,
  },
];

/**
 * How a pool is split, named after the red packets everyone knows (the
 * algorithm's own name in the small print).
 */
export const algorithmLabels: Record<Algorithm, string> = splitNames;

const algorithmOptions: {
  value: Algorithm;
  title: string;
  description: string;
}[] = [
  {
    value: "double_mean",
    title: algorithmLabels.double_mean,
    description: splitRules.double_mean,
  },
  {
    value: "bounded_mean",
    title: algorithmLabels.bounded_mean,
    description: splitRules.bounded_mean,
  },
];

/**
 * One quiet line that opens the 更多设置 panel at a group: what is set now,
 * and 改. Red with the first problem when the panel holds one.
 */
export function QuietLine({
  id,
  text,
  error,
  onOpen,
}: {
  id: string;
  text: ReactNode;
  error?: string;
  onOpen: () => void;
}) {
  return (
    <Squircle radius={radius.row}>
      <button
        id={id}
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm transition-colors hover:bg-fill-2",
          error ? "text-danger" : "text-ink-2",
        )}
      >
        <span className="grid min-w-0 flex-1">
          <span className="truncate">{text}</span>
          {error && <span className="text-xs">{error}</span>}
        </span>
        <span className="flex shrink-0 items-center text-accent-ink">
          改
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
      </button>
    </Squircle>
  );
}

/** Step ②: the amounts for the chosen 玩法, and what they add up to. */
export function AmountFields({
  form,
  update,
  errorOf,
  locked,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  locked: boolean;
}) {
  const { total, shares, unit } = plan(form);
  const amountProps = (field: string) => ({
    id: field,
    inputMode: "decimal" as const,
    suffix: "LDC",
    invalid: Boolean(errorOf(field)),
    disabled: locked,
    autoComplete: "off",
  });
  const countProps = (field: string, suffix: string) => ({
    id: field,
    inputMode: "numeric" as const,
    suffix,
    invalid: Boolean(errorOf(field)),
    disabled: locked,
    autoComplete: "off",
  });
  type Entry = [
    field: string,
    label: string,
    placeholder: string,
    value: string,
    set: (current: FormState, value: string) => FormState,
  ];
  const pair = (first: Entry, second: Entry) => (
    <div className="grid gap-4 @wide/window:grid-cols-2">
      {[first, second].map(([field, label, placeholder, value, set], index) => (
        <Field key={field} label={label} htmlFor={field} error={errorOf(field)}>
          <TextInput
            {...(index === 0
              ? amountProps(field)
              : countProps(field, form.mode === "timed_draw" ? "人" : "份"))}
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              const next = event.target.value;
              update((current) => set(current, next));
            }}
          />
        </Field>
      ))}
    </div>
  );

  return (
    <>
      {form.mode === "random" &&
        pair(
          [
            "hb-random-total",
            "总额",
            "30.00",
            form.random.total,
            (current, total) => ({
              ...current,
              random: { ...current.random, total },
            }),
          ],
          [
            "hb-random-count",
            "份数",
            "30",
            form.random.count,
            (current, count) => ({
              ...current,
              random: { ...current.random, count },
            }),
          ],
        )}
      {form.mode === "timed_draw" &&
        pair(
          [
            "hb-draw-pool",
            "奖池",
            "20.00",
            form.draw.pool,
            (current, pool) => ({
              ...current,
              draw: { ...current.draw, pool },
            }),
          ],
          [
            "hb-draw-winners",
            "获奖名额",
            "5",
            form.draw.winners,
            (current, winners) => ({
              ...current,
              draw: { ...current.draw, winners },
            }),
          ],
        )}
      {form.mode === "fixed" &&
        pair(
          [
            "hb-fixed-unit",
            "每份金额",
            "0.88",
            form.fixed.unit,
            (current, unit) => ({
              ...current,
              fixed: { ...current.fixed, unit },
            }),
          ],
          [
            "hb-fixed-count",
            "份数",
            "20",
            form.fixed.count,
            (current, count) => ({
              ...current,
              fixed: { ...current.fixed, count },
            }),
          ],
        )}
      {form.mode === "custom" && (
        <Field
          label="每份金额"
          htmlFor="hb-custom-lines"
          hint="一行一份；最多 1,000 行。"
          error={errorOf("hb-custom-lines")}
          aside={`${customLines(form).length} 份`}
        >
          <TextArea
            id="hb-custom-lines"
            rows={5}
            className="font-mono"
            placeholder={"8.88\n6.66\n5.20"}
            value={form.custom.lines}
            disabled={locked}
            invalid={Boolean(errorOf("hb-custom-lines"))}
            onChange={(event) => {
              const lines = event.target.value;
              update((current) => ({
                ...current,
                custom: { ...current.custom, lines },
              }));
            }}
          />
        </Field>
      )}
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-line border-t pt-4 text-sm text-ink-2">
        {total !== null ? (
          <span>
            {form.mode === "timed_draw" ? "奖池" : "总额"}{" "}
            <span className="text-base font-semibold text-ink tabular-nums">
              {ldc(total)}
            </span>{" "}
            LDC
          </span>
        ) : (
          <span>{form.mode === "timed_draw" ? "奖池未填" : "总额未填"}</span>
        )}
        <span className="text-ink-3">
          ·{" "}
          {shares !== null
            ? `${shares} ${form.mode === "timed_draw" ? "个名额" : "份"}`
            : "份数未填"}
          {unit !== null && ` · 每份 ${ldc(unit)} LDC`}
        </span>
      </p>
      <div className="-mt-3 flex flex-col gap-1">
        <p className="text-xs text-ink-3">
          最多 1,000 份，每份至少 0.01
          LDC，金额最多两位小数。填的是每份发出的金额。
          {form.funding === "balance"
            ? "领到的直接存进领取人的🐟额。"
            : "领取的人到账时，Credit 会按你的 Credit 等级扣分发费（4%–15%）。"}
          你不能领自己的红包。
        </p>
        {/* Opens as the total passes 800 LDC, and closes under it; 🐟额
            does not go through Credit at all. */}
        <Reveal
          show={
            form.funding !== "balance" &&
            total !== null &&
            total > DAILY_LIMIT_FLOOR
          }
        >
          <p className="text-xs text-warning">
            Credit 每天最多能发 800–2000 LDC（按你的 Credit
            等级），超出的部分可能顺延到第二天发放。
          </p>
        </Reveal>
      </div>
    </>
  );
}

/** 微信同款 or 支付宝同款, and what that gives with the amounts filled in. */
/**
 * 从哪发 (docs/balance-design.md §14), over the amounts. With 🐟额红包 on
 * and a 🐟额 to send from, two cards: each says where it stands, one that
 * cannot be used now is grey, and the way to fix it is right under them.
 * Otherwise only a merchant's trouble shows, in one line. Over 可用, a line
 * says so; the draft still saves, and opening checks again.
 */
export function FundingChoice({
  form,
  update,
  locked,
}: {
  form: FormState;
  update: Update;
  locked: boolean;
}) {
  const user = useSessionUser();
  const { leaveTo } = useOmniboxController();
  const { merchant, loaded } = useCurrentMerchant(user?.id ?? "");
  const funding = useBalanceFunding(user?.id ?? "", !locked);
  const available = funding.data?.availableMinor ?? 0;
  const fishReady = funding.data?.available === true;
  const rejected = merchant?.credentialVerification.status === "rejected";
  const noMerchant = loaded && !merchant;
  const { total } = plan(form);
  const merchantLink = (noMerchant || rejected) && (
    <MoreLink href="/merchant" onGo={() => void leaveTo({ to: "/merchant" })}>
      {noMerchant ? "去配置商户" : "去更新密钥"}
    </MoreLink>
  );
  if (locked) return null;
  // No 🐟额 to choose: only a merchant's trouble, where the money is set.
  if (form.funding !== "balance" && !(funding.data?.enabled && user?.balance))
    return noMerchant || rejected ? (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-warning">
        <span className="min-w-0">
          {noMerchant
            ? "还没有配置 LDC 商户，配置好才能保存和开放。"
            : "商户凭证未通过，开放前要更新密钥。"}
        </span>
        {merchantLink}
      </p>
    ) : null;
  return (
    <div className="grid gap-2">
      <ChoiceCards
        label="从哪发"
        value={form.funding}
        onChange={(value) =>
          update((current) => ({ ...current, funding: value }))
        }
        options={[
          {
            value: "merchant",
            title: "LDC 商户",
            description: noMerchant
              ? "还没有配置商户"
              : rejected
                ? "商户凭证未通过，开放前要更新"
                : "每有人领取，从你的集市应用直接付给他",
            icon: Store,
            disabled: noMerchant,
          },
          {
            value: "balance",
            title: "🐟额",
            // 🐟额 itself is written in 🐟; LDC with a small 🐟 is for a
            // 红包's money as others see it (balance-design §14).
            description: fishReady
              ? `可用 ${ldc(Math.max(0, available))} 🐟，领到的进领取人的🐟额`
              : "🐟额里没有可用",
            icon: Wallet,
            disabled: !fishReady,
          },
        ]}
      />
      {(merchantLink || !fishReady) && (
        <div className="flex flex-wrap gap-x-3 px-1">
          {merchantLink}
          {!fishReady && (
            <MoreLink
              href="/balance"
              onGo={() => void leaveTo({ to: "/balance" })}
            >
              去🐟额
            </MoreLink>
          )}
        </div>
      )}
      <Reveal
        show={
          form.funding === "balance" &&
          fishReady &&
          total !== null &&
          total > available
        }
      >
        <p className="px-1 text-xs text-warning">
          可用只有 {ldc(Math.max(0, available))} 🐟，不够发这个红包。
        </p>
      </Reveal>
    </div>
  );
}

export function AlgorithmCards({
  label,
  value,
  onChange,
  range,
  shares,
  pool = false,
}: {
  label: string;
  value: Algorithm;
  onChange: (value: Algorithm) => void;
  range: [number, number] | null;
  shares: number | null;
  /** A timed draw's prizes add up to its 奖池, not a 总额. */
  pool?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <ChoiceCards
        label={label}
        value={value}
        onChange={onChange}
        options={algorithmOptions}
      />
      {range && (
        <p className="text-xs text-ink-3">
          {shares === 1
            ? `只有一份：就是全部 ${ldc(range[0])} LDC。`
            : range[0] === range[1]
              ? `按现在的金额，每份都是 ${ldc(range[0])} LDC。`
              : `按现在的金额，每份 ${ldc(range[0])}–${ldc(range[1])} LDC，加起来正好是${pool ? "奖池" : "总额"}。`}
        </p>
      )}
    </div>
  );
}

/**
 * After opening: the merchant that pays this 红包. It was the current one
 * when the 红包 opened and stays so, even if the account changes merchant.
 */
export function PaidByRow({ merchantId }: { merchantId: string }) {
  const user = useSessionUser();
  const { leaveTo } = useOmniboxController();
  const navigate = useNavigate();
  const merchant = useMerchant(user?.id ?? "", merchantId).data?.merchant;
  if (!merchant) return null;
  const current = merchant.usageStatus === "current";
  return (
    <div className="grid min-w-0 gap-2">
      <Squircle radius={12}>
        <div className="flex min-w-0 items-center gap-3 bg-fill px-3.5 py-2.5">
          <KeyRound className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm text-ink">
            {merchant.label}
            <span className="ml-2 font-mono text-xs text-ink-3">
              {merchant.clientId}
            </span>
            {!current && (
              <span className="ml-2 text-xs text-ink-3">历史商户</span>
            )}
          </span>
          <MoreLink
            href={current ? "/merchant" : `/merchant/${merchant.id}`}
            onGo={() =>
              current
                ? void leaveTo({ to: "/merchant" })
                : void navigate({
                    to: "/merchant/$merchantId",
                    params: { merchantId: merchant.id },
                  })
            }
          >
            查看
          </MoreLink>
        </div>
      </Squircle>
      <p className="text-xs text-ink-3">
        开放时用的商户，之后不能更换；账号换了当前商户，这个红包仍由它付款。
      </p>
    </div>
  );
}

const credentialWords = {
  passed: "凭证检查通过 · 开放时会自动再查一次",
  checking: "正在检查凭证…",
  rejected: "凭证未通过",
  unverified: "凭证未检查 · 开放时会自动检查",
  unavailable: "暂时无法检查凭证",
} as const;

/** The current merchant and its 凭证 (more settings · 付款). */
export function MerchantRow() {
  const user = useSessionUser();
  const { leaveTo } = useOmniboxController();
  const { merchant } = useCurrentMerchant(user?.id ?? "");
  return (
    <div className="grid gap-2">
      <Squircle radius={12}>
        <div className="flex items-center gap-3 bg-fill px-3.5 py-2.5">
          <KeyRound className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          {merchant ? (
            <span className="grid min-w-0 flex-1">
              <span className="truncate text-sm text-ink">
                {merchant.label}
                <span className="ml-2 font-mono text-xs text-ink-3">
                  {merchant.clientId}
                </span>
              </span>
              <span className="text-xs text-ink-3">
                {credentialWords[merchant.credentialVerification.status]}
              </span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 text-sm text-ink-2">
              还没有配置商户
            </span>
          )}
          <MoreLink
            href="/merchant"
            onGo={() => void leaveTo({ to: "/merchant" })}
          >
            {merchant ? "管理" : "去配置"}
          </MoreLink>
        </div>
      </Squircle>
      <p className="text-xs text-ink-3">
        不用预先付款：每次有人领取，本站从这个集市应用直接付给领取人。请让商户里留有足够的
        LDC。
      </p>
    </div>
  );
}

export function PasswordList({
  form,
  update,
  errorOf,
  locked,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  locked: boolean;
}) {
  const setAt = (index: number, value: string) =>
    update((current) => ({
      ...current,
      passwords: current.passwords.map((item, at) =>
        at === index ? value : item,
      ),
    }));
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">口令</span>
        <span className="text-xs text-ink-3">
          {form.passwords.length} / {LIMITS.passwords}
        </span>
      </div>
      <ul className="grid gap-2">
        {form.passwords.map((password, index) => {
          const field = `hb-password-${index}`;
          const inspection = inspectPassword(password);
          const error = errorOf(field);
          const fixable =
            password.length > 0 && optimizePassword(password) !== password;
          return (
            // Rows are only added at the end and removed by position.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={index} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                {/* A long 口令 wraps: the whole of it in view while typing. */}
                <WrapInput
                  id={field}
                  aria-label={`口令 ${index + 1}`}
                  className="flex-1"
                  value={password}
                  placeholder={
                    index === 0 ? "例如 周末口令2026" : "再加一个口令"
                  }
                  // A sentence pasted with its punctuation still fits; 优化
                  // takes the punctuation out.
                  maxLength={64}
                  disabled={locked}
                  invalid={Boolean(error)}
                  autoComplete="off"
                  spellCheck={false}
                  suffix={`${inspection.length} / ${ACTIVITY_LIMITS.passwordMaxCharacters}`}
                  aria-describedby={error ? `${field}-error` : undefined}
                  onChange={(event) => setAt(index, event.target.value)}
                />
                {/* Named as in the command box (一键优化 → 优化); it grows in
                    beside the 口令 and folds away once the 口令 is clean. */}
                <RevealInline show={!locked && fixable}>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="一键优化：全角字母数字转半角，去掉不能用的字符"
                    aria-label={`优化口令 ${index + 1}`}
                    onClick={() => {
                      setAt(index, optimizePassword(password));
                      // The button goes once the 口令 is clean: stay in it.
                      document.getElementById(field)?.focus();
                    }}
                  >
                    <Sparkles />
                    优化
                  </Button>
                </RevealInline>
                <RevealInline show={!locked && form.passwords.length > 1}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`删除口令 ${index + 1}`}
                    onClick={() => {
                      update((current) => ({
                        ...current,
                        passwords: current.passwords.filter(
                          (_, at) => at !== index,
                        ),
                      }));
                      // Rows are kept by position: the one above (or the
                      // next one, now in this place) takes the focus.
                      document
                        .getElementById(`hb-password-${Math.max(0, index - 1)}`)
                        ?.focus();
                    }}
                  >
                    <Trash2 />
                  </Button>
                </RevealInline>
              </div>
              <Reveal show={Boolean(error)}>
                <p id={`${field}-error`} className="text-xs text-danger">
                  {error}
                </p>
              </Reveal>
            </li>
          );
        })}
      </ul>
      {/* Locked: the step's own 开放后不能修改 covers the 口令 too. */}
      {!locked && (
        <div className="flex flex-wrap items-center gap-3">
          <RevealInline show={form.passwords.length < LIMITS.passwords}>
            <Button
              size="sm"
              onClick={() =>
                update((current) => ({
                  ...current,
                  passwords: [...current.passwords, ""],
                }))
              }
            >
              <Plus />
              再加一个
            </Button>
          </RevealInline>
          <span className="text-xs text-ink-3">
            6–32
            个字：汉字、英文字母或数字，区分大小写。几个口令共用同一个红包，每人只能领一次。
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * When it closes (a timed draw: the latest draw): so long after opening,
 * or at a set time. The heading above names it; the 报名上限 of a timed
 * draw is a setting of its own (DrawLimitField).
 */
export function TimingFields({
  form,
  update,
  errorOf,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
}) {
  const draw = form.mode === "timed_draw";
  return (
    <div className="grid gap-3">
      <ChoiceCards
        label={draw ? "开奖时间的定法" : "截止时间的定法"}
        value={form.timing.kind}
        onChange={(kind) =>
          update((current) => ({
            ...current,
            timing: { ...current.timing, kind },
          }))
        }
        options={[
          {
            value: "duration",
            title: draw ? "开放后多久开奖" : "开放后多久截止",
            description: "从开放的那一刻开始计时",
          },
          {
            value: "at",
            title: draw ? "指定开奖时间" : "指定截止时间",
            description: "按这台设备的时区",
          },
        ]}
      />
      {/* 多久 and 什么时候 fade into each other in place. */}
      <Swap id={form.timing.kind}>
        {form.timing.kind === "duration" ? (
          <Field
            label={draw ? "开放后多久开奖" : "开放多久"}
            labelHidden
            htmlFor="hb-timing-value"
            error={errorOf("hb-timing-value")}
            live
          >
            <div className="flex flex-wrap items-center gap-2">
              <TextInput
                id="hb-timing-value"
                inputMode="numeric"
                className="w-32"
                value={form.timing.value}
                invalid={Boolean(errorOf("hb-timing-value"))}
                onChange={(event) => {
                  const value = event.target.value;
                  update((current) => ({
                    ...current,
                    timing: { ...current.timing, value },
                  }));
                }}
              />
              <Segmented
                label="时长单位"
                value={form.timing.unit}
                onChange={(unit: TimeUnit) =>
                  update((current) => ({
                    ...current,
                    timing: { ...current.timing, unit },
                  }))
                }
                // Seconds only for a timed draw's countdown.
                options={(Object.keys(unitLabels) as TimeUnit[])
                  .filter((value) => draw || value !== "seconds")
                  .map((value) => ({
                    value,
                    label: unitLabels[value],
                  }))}
              />
            </div>
          </Field>
        ) : (
          <Field
            label={draw ? "开奖时间" : "截止时间"}
            labelHidden
            htmlFor="hb-timing-at"
            error={errorOf("hb-timing-at")}
            live
          >
            <TextInput
              id="hb-timing-at"
              type="datetime-local"
              className="w-fit"
              value={form.timing.at}
              invalid={Boolean(errorOf("hb-timing-at"))}
              onChange={(event) => {
                const at = event.target.value;
                update((current) => ({
                  ...current,
                  timing: { ...current.timing, at },
                }));
              }}
            />
          </Field>
        )}
      </Swap>
    </div>
  );
}

/** A timed draw's 报名上限: optional; full means the draw happens at once. */
export function DrawLimitField({
  form,
  update,
  errorOf,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
}) {
  return (
    <Field
      label="报名上限"
      labelHidden
      htmlFor="hb-draw-limit"
      hint="选填。留空不限；报满时立即开奖。"
      error={errorOf("hb-draw-limit")}
      live
    >
      <TextInput
        id="hb-draw-limit"
        inputMode="numeric"
        className="w-40"
        suffix="人"
        placeholder="不限"
        value={form.draw.limit}
        invalid={Boolean(errorOf("hb-draw-limit"))}
        onChange={(event) => {
          const limit = event.target.value;
          update((current) => ({
            ...current,
            draw: { ...current.draw, limit },
          }));
        }}
      />
    </Field>
  );
}

/** When 跳到 last moved focus itself (it does its own scrolling). */
let jumpedAt = 0;

export function justJumped() {
  return Date.now() - jumpedAt < 1000;
}

/** Scroll a field into the middle of its scroller and focus it. */
export function jumpTo(field: string) {
  const element = document.getElementById(field);
  if (!element) return;
  // The bar's reveal on focus must not cut this centring short.
  jumpedAt = Date.now();
  element.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  element.focus({ preventScroll: true });
}

/** Mark focus moved by the flow itself (a new step): no reveal on it. */
export function markJumped() {
  jumpedAt = Date.now();
}

export function IssueList({
  issues,
  onJump,
}: {
  issues: Issue[];
  onJump: (field: string) => void;
}) {
  return (
    <Callout
      tone="danger"
      icon={AlertTriangle}
      title={`还有 ${issues.length} 处要改`}
    >
      <ul className="grid gap-0.5">
        {issues.slice(0, 6).map((issue) => (
          <li key={`${issue.field}:${issue.message}`}>
            <button
              type="button"
              onClick={() => onJump(issue.field)}
              className="text-left text-sm text-danger underline decoration-danger/30 underline-offset-2 hover:decoration-danger"
            >
              {issue.message}
            </button>
          </li>
        ))}
        {issues.length > 6 && (
          <li className="text-xs text-ink-3">还有 {issues.length - 6} 处…</li>
        )}
      </ul>
    </Callout>
  );
}
