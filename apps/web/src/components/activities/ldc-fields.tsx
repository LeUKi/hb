import {
  ACTIVITY_LIMITS,
  amountToMinor,
  DEFAULT_DRAW_COUNTDOWN_SECONDS,
  formatAmount,
  moneySchema,
  type PaymentMode,
  type TimedDrawMoney,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMerchant, useMerchants } from "../../lib/merchants";
import { publicationReason } from "../../lib/payment-display";
import {
  formatCountdownSeconds,
  isTimedDrawMoney,
  timedDrawSummary,
  type WebLdcMoney,
} from "../../lib/timed-draw";
import { Button } from "../ui/button";
import { ActivityErrorView } from "./activity-error";
import { RandomMoneySummary } from "./random-money-summary";
import { RealPaymentNotice } from "./real-payment-notice";
import { SimulationNotice } from "./simulation-notice";

function fixedUnitAmount(money: WebLdcMoney) {
  const amounts = money.mode === "custom" ? money.amounts : [money.totalAmount];
  const count = money.mode === "custom" ? money.amounts.length : money.count;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    amounts.some((amount) => !moneySchema.safeParse(amount).success)
  )
    return "";
  const total = amounts.reduce(
    (sum, amount) => sum + BigInt(amountToMinor(amount)),
    0n,
  );
  return total <= BigInt(Number.MAX_SAFE_INTEGER) &&
    total % BigInt(count) === 0n
    ? formatAmount(Number(total / BigInt(count)))
    : "";
}

function fixedTotal(unitAmount: string, count: number) {
  if (
    !moneySchema.safeParse(unitAmount).success ||
    !Number.isSafeInteger(count) ||
    count < 1
  )
    return unitAmount;
  const total = BigInt(amountToMinor(unitAmount)) * BigInt(count);
  return `${(total / 100n).toString()}.${(total % 100n).toString().padStart(2, "0")}`;
}

export function LdcFields({
  userId,
  merchantId,
  money,
  allocation,
  disabled,
  paymentMode,
  lockedPaymentMode,
  autoBindCurrent,
  onMerchant,
  onMoney,
  onAllocation,
}: {
  userId: string;
  merchantId: string;
  money: WebLdcMoney;
  allocation: "sequential" | "random";
  disabled: boolean;
  paymentMode?: PaymentMode;
  lockedPaymentMode?: PaymentMode;
  autoBindCurrent: boolean;
  onMerchant: (id: string) => void;
  onMoney: (money: WebLdcMoney) => void;
  onAllocation: (allocation: "sequential" | "random") => void;
}) {
  const [unitAmount, setUnitAmount] = useState(() => fixedUnitAmount(money));
  const [fixedNeedsAmount] = useState(
    () => money.mode !== "fixed" && !fixedUnitAmount(money),
  );
  const initialSeed =
    money.mode === "custom"
      ? { totalAmount: "", count: Math.max(1, money.amounts.length) }
      : { totalAmount: money.totalAmount, count: money.count };
  const drafts = useRef({
    fixedUnit: fixedUnitAmount(money),
    fixedCount: money.mode === "custom" ? money.amounts.length : money.count,
    randomVisited: money.mode === "random",
    random:
      money.mode === "random"
        ? {
            algorithm: money.algorithm,
            totalAmount: money.totalAmount,
            count: money.count,
          }
        : {
            algorithm: "double_mean_v1" as const,
            ...initialSeed,
          },
    customAllocation: money.mode === "custom" ? allocation : "sequential",
    amounts: money.mode === "custom" ? money.amounts : [""],
    timedDrawVisited: isTimedDrawMoney(money),
    timedDraw: isTimedDrawMoney(money)
      ? money
      : ({
          mode: "timed_draw",
          algorithm: "double_mean_v1",
          totalAmount: initialSeed.totalAmount,
          count: initialSeed.count,
          participantLimit: initialSeed.count,
          countdownSeconds: DEFAULT_DRAW_COUNTDOWN_SECONDS,
          distributeFullPool: true,
        } satisfies TimedDrawMoney),
  });
  const plan = isTimedDrawMoney(money)
    ? "timed_draw"
    : money.mode === "fixed"
      ? "fixed"
      : money.mode === "random"
        ? "random"
        : "custom";
  function rememberCurrentPlan() {
    if (money.mode === "custom") {
      drafts.current.amounts = money.amounts;
      drafts.current.customAllocation = allocation;
    } else if (isTimedDrawMoney(money)) {
      drafts.current.timedDraw = money;
      drafts.current.timedDrawVisited = true;
    } else if (money.mode === "random") {
      drafts.current.randomVisited = true;
      drafts.current.random = {
        algorithm: money.algorithm,
        totalAmount: money.totalAmount,
        count: money.count,
      };
    } else {
      drafts.current.fixedUnit = unitAmount;
      drafts.current.fixedCount = money.count;
    }
  }
  function choosePlan(next: string) {
    rememberCurrentPlan();
    if (next === "timed_draw") {
      const seedCount =
        money.mode === "custom"
          ? Math.max(1, money.amounts.length)
          : money.count;
      const seedAmount =
        money.mode === "custom"
          ? drafts.current.timedDraw.totalAmount
          : money.totalAmount;
      const draft = drafts.current.timedDrawVisited
        ? drafts.current.timedDraw
        : ({
            ...drafts.current.timedDraw,
            totalAmount: seedAmount,
            count: seedCount,
            participantLimit: seedCount,
          } satisfies TimedDrawMoney);
      drafts.current.timedDraw = draft;
      drafts.current.timedDrawVisited = true;
      onMoney(draft);
      onAllocation("random");
    } else if (next === "custom") {
      onMoney({ mode: "custom", amounts: drafts.current.amounts });
      onAllocation(drafts.current.customAllocation);
    } else if (next === "random") {
      const draft = drafts.current.randomVisited
        ? drafts.current.random
        : {
            ...drafts.current.random,
            totalAmount:
              money.mode === "custom"
                ? drafts.current.random.totalAmount
                : money.totalAmount,
            count:
              money.mode === "custom"
                ? Math.max(1, money.amounts.length)
                : money.count,
          };
      drafts.current.random = draft;
      drafts.current.randomVisited = true;
      onMoney({
        mode: "random",
        algorithm: draft.algorithm,
        totalAmount: draft.totalAmount,
        count: draft.count,
      });
      onAllocation("random");
    } else {
      setUnitAmount(drafts.current.fixedUnit);
      onMoney({
        mode: "fixed",
        totalAmount: fixedTotal(
          drafts.current.fixedUnit,
          drafts.current.fixedCount,
        ),
        count: drafts.current.fixedCount,
      });
      onAllocation("sequential");
    }
  }
  function chooseRandomAlgorithm(
    algorithm: "double_mean_v1" | "bounded_mean_v1",
  ) {
    rememberCurrentPlan();
    const totalAmount =
      money.mode === "random"
        ? money.totalAmount
        : drafts.current.random.totalAmount;
    const count =
      money.mode === "random" ? money.count : drafts.current.random.count;
    const draft = { algorithm, totalAmount, count };
    drafts.current.random = draft;
    drafts.current.randomVisited = true;
    onMoney({ mode: "random", ...draft });
    onAllocation("random");
  }
  const merchants = useMerchants(userId);
  const currentId = merchants.data?.currentMerchantId ?? "";
  const currentQuery = useMerchant(userId, currentId);
  const selectedQuery = useMerchant(userId, merchantId);
  const current =
    currentQuery.data?.merchant ??
    merchants.data?.items.find((merchant) => merchant.id === currentId);
  const selected =
    selectedQuery.data?.merchant ??
    merchants.data?.items.find((merchant) => merchant.id === merchantId);
  const notCurrent =
    merchants.isSuccess && Boolean(merchantId && merchantId !== currentId);
  const compatible =
    current && (!lockedPaymentMode || current.mode === lockedPaymentMode);
  useEffect(() => {
    if (!disabled && autoBindCurrent && !merchantId && currentId && compatible)
      onMerchant(currentId);
  }, [
    disabled,
    autoBindCurrent,
    merchantId,
    currentId,
    compatible,
    onMerchant,
  ]);
  const values = money.mode === "custom" ? money.amounts : [money.totalAmount];
  const valid =
    values.length > 0 &&
    values.every((amount) => moneySchema.safeParse(amount).success);
  const total = valid
    ? values.reduce((sum, amount) => sum + BigInt(amountToMinor(amount)), 0n)
    : null;
  const amountLabel =
    total !== null && total <= BigInt(Number.MAX_SAFE_INTEGER)
      ? formatAmount(Number(total))
      : null;
  return (
    <div className="space-y-5">
      {paymentMode === "real" ? (
        <RealPaymentNotice draft={!disabled} />
      ) : paymentMode === "simulation" ? (
        <SimulationNotice />
      ) : null}
      {lockedPaymentMode ? (
        <p className="text-sm text-neutral-600">
          付款模式已固定，草稿只能明确改用同模式的当前商户。
        </p>
      ) : null}
      {merchants.isError ? (
        <ActivityErrorView
          error={merchants.error}
          retry={() => merchants.refetch()}
        />
      ) : (
        <label className="activity-label" htmlFor="activity-merchantId">
          发放商户
          <input
            id="activity-merchantId"
            className="activity-input"
            value={
              selected
                ? `${selected.label}（${selected.clientId}） · ${notCurrent ? "历史商户" : "当前商户"}`
                : merchantId
                  ? `已保存商户 · ${merchantId}`
                  : merchants.isPending
                    ? "正在读取当前商户…"
                    : "尚未配置当前商户"
            }
            readOnly
            disabled={disabled || merchants.isPending}
            aria-describedby="activity-merchant-help"
          />
        </label>
      )}
      <div id="activity-merchant-help" className="space-y-2 text-sm">
        {disabled ? (
          <p className="text-neutral-600">
            活动发放商户已固定。凭证更新不改变奖励金额或收款人。
          </p>
        ) : notCurrent ? (
          <>
            <p className="text-amber-800">
              草稿保留原商户，不会自动切换。开放新的 LDC 活动须使用当前商户。
            </p>
            {current ? (
              <>
                <p className="break-words text-neutral-600">
                  当前商户：{current.label}（{current.clientId}）
                </p>
                {compatible ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => onMerchant(current.id)}
                  >
                    改用当前商户
                  </Button>
                ) : (
                  <p className="text-amber-800">
                    当前商户付款模式与草稿不一致，不能重新绑定。
                  </p>
                )}
                <p className="text-xs text-neutral-500">
                  重新绑定仅在保存后生效，不改变已生成的金额库存。
                </p>
              </>
            ) : (
              <p className="text-neutral-600">请先配置当前商户。</p>
            )}
          </>
        ) : selected ? (
          <p className="text-neutral-600">
            {selected.publicationEligibility.allowed
              ? "当前商户可用于开放新的 LDC 活动。"
              : publicationReason(selected.publicationEligibility.reason)}
          </p>
        ) : merchants.isSuccess ? (
          <p className="text-neutral-600">
            请先配置当前商户，再保存 LDC 活动。文本活动不需要商户。
          </p>
        ) : null}
      </div>
      {!disabled ? (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Link to="/my/merchants" className="underline underline-offset-4">
            管理商户
          </Link>
        </div>
      ) : null}
      <label className="activity-label" htmlFor="activity-money">
        奖励方式
        <select
          id="activity-money"
          className="activity-input"
          value={plan}
          disabled={disabled}
          onChange={(event) => choosePlan(event.target.value)}
        >
          <option value="fixed">固定均分</option>
          <option value="random">即时随机</option>
          <option value="custom">自定义金额</option>
          <option value="timed_draw">限时开奖</option>
        </select>
      </label>
      {money.mode === "random" ? (
        <label className="activity-label" htmlFor="ldc-random-algorithm">
          随机算法
          <select
            id="ldc-random-algorithm"
            className="activity-input"
            value={money.algorithm}
            disabled={disabled}
            onChange={(event) =>
              chooseRandomAlgorithm(
                event.target.value === "bounded_mean_v1"
                  ? "bounded_mean_v1"
                  : "double_mean_v1",
              )
            }
          >
            <option value="double_mean_v1">二倍均值法</option>
            <option value="bounded_mean_v1">均值上下 50%</option>
          </select>
        </label>
      ) : null}
      {money.mode === "custom" ? (
        <label className="activity-label" htmlFor="ldc-custom-allocation">
          发放顺序
          <select
            id="ldc-custom-allocation"
            className="activity-input"
            value={allocation}
            disabled={disabled}
            onChange={(event) => {
              const next =
                event.target.value === "random" ? "random" : "sequential";
              drafts.current.customAllocation = next;
              onAllocation(next);
            }}
          >
            <option value="sequential">按顺序领取</option>
            <option value="random">随机领取，不放回</option>
          </select>
        </label>
      ) : null}
      {isTimedDrawMoney(money) ? (
        <TimedDrawFields
          money={money}
          disabled={disabled}
          onMoney={(next) => onMoney(next)}
        />
      ) : money.mode !== "custom" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="activity-label" htmlFor="ldc-total">
            {money.mode === "fixed" ? "每份金额（LDC）" : "总奖池（LDC）"}
            <input
              id="ldc-total"
              className="activity-input"
              inputMode="decimal"
              value={money.mode === "fixed" ? unitAmount : money.totalAmount}
              disabled={disabled}
              onChange={(event) => {
                if (money.mode === "fixed") {
                  setUnitAmount(event.target.value);
                  onMoney({
                    ...money,
                    totalAmount: fixedTotal(event.target.value, money.count),
                  });
                } else onMoney({ ...money, totalAmount: event.target.value });
              }}
            />
          </label>
          <label className="activity-label" htmlFor="ldc-count">
            奖励份数
            <input
              id="ldc-count"
              className="activity-input"
              type="number"
              min={1}
              max={ACTIVITY_LIMITS.rewards}
              step={1}
              value={money.count || ""}
              disabled={disabled}
              onChange={(event) => {
                const count = Number(event.target.value);
                onMoney(
                  money.mode === "fixed"
                    ? {
                        ...money,
                        count,
                        totalAmount: fixedTotal(unitAmount, count),
                      }
                    : { ...money, count },
                );
              }}
            />
          </label>
        </div>
      ) : (
        <label className="activity-label" htmlFor="ldc-amounts">
          每份金额（每行一个）
          <textarea
            id="ldc-amounts"
            aria-label="每份金额（每行一个）"
            className="activity-input min-h-40"
            value={money.amounts.join("\n")}
            disabled={disabled}
            onChange={(event) =>
              onMoney({
                mode: "custom",
                amounts: event.target.value.split(/\r?\n/),
              })
            }
          />
        </label>
      )}
      {isTimedDrawMoney(money) ? (
        <p className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm leading-6 text-neutral-600">
          {timedDrawSummary(money)}
        </p>
      ) : money.mode === "random" ? (
        <RandomMoneySummary money={money} opened={disabled} />
      ) : null}
      {!isTimedDrawMoney(money) &&
      money.mode === "fixed" &&
      fixedNeedsAmount &&
      !unitAmount ? (
        <p className="text-sm text-amber-800">
          原总额无法按份数精确均分为两位小数，请填写每份金额。
        </p>
      ) : null}
      <p className="text-xs leading-6 text-neutral-500">
        最多 1,000 份，每份至少 0.01
        LDC，金额最多两位小数。填写的是发放金额，领取者承担自己一侧手续费。作者不能领取自己的
        LDC 活动。
      </p>
      {amountLabel && !isTimedDrawMoney(money) ? (
        <p className="text-sm">
          总发放金额：{amountLabel} LDC ·{" "}
          {money.mode === "custom" ? money.amounts.length : money.count} 份
        </p>
      ) : null}
    </div>
  );
}

function TimedDrawFields({
  money,
  disabled,
  onMoney,
}: {
  money: TimedDrawMoney;
  disabled: boolean;
  onMoney: (money: TimedDrawMoney) => void;
}) {
  const participantLimit = money.participantLimit ?? "";
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="activity-label" htmlFor="timed-total">
          总奖池（LDC）
          <input
            id="timed-total"
            className="activity-input"
            inputMode="decimal"
            value={money.totalAmount}
            disabled={disabled}
            onChange={(event) =>
              onMoney({ ...money, totalAmount: event.target.value })
            }
          />
        </label>
        <label className="activity-label" htmlFor="timed-count">
          获奖名额
          <input
            id="timed-count"
            className="activity-input"
            type="number"
            min={1}
            max={ACTIVITY_LIMITS.rewards}
            step={1}
            value={money.count || ""}
            disabled={disabled}
            onChange={(event) => {
              const count = Number(event.target.value);
              onMoney({
                ...money,
                count,
                participantLimit: money.participantLimit,
              });
            }}
          />
        </label>
        <label className="activity-label" htmlFor="timed-participant-limit">
          报名上限
          <input
            id="timed-participant-limit"
            className="activity-input"
            type="number"
            min={1}
            step={1}
            placeholder="不限制"
            value={participantLimit}
            disabled={disabled}
            onChange={(event) =>
              onMoney({
                ...money,
                participantLimit: event.target.value
                  ? Number(event.target.value)
                  : null,
              })
            }
          />
          <span className="text-xs font-normal text-neutral-500">
            首次进入默认等于获奖名额；留空表示不限制报名人数。
          </span>
        </label>
        <label className="activity-label" htmlFor="timed-countdown">
          最晚开奖倒计时（秒）
          <input
            id="timed-countdown"
            className="activity-input"
            type="number"
            min={1}
            step={1}
            value={money.countdownSeconds || ""}
            disabled={disabled}
            onChange={(event) =>
              onMoney({
                ...money,
                countdownSeconds: Number(event.target.value),
              })
            }
          />
          <span className="text-xs font-normal text-neutral-500">
            默认 86400 秒；当前设置：
            {formatCountdownSeconds(money.countdownSeconds)}。
          </span>
        </label>
      </div>
      <label className="activity-label" htmlFor="timed-algorithm">
        抽奖金额算法
        <select
          id="timed-algorithm"
          className="activity-input"
          value={money.algorithm}
          disabled={disabled}
          onChange={(event) =>
            onMoney({
              ...money,
              algorithm:
                event.target.value === "bounded_mean_v1"
                  ? "bounded_mean_v1"
                  : "double_mean_v1",
            })
          }
        >
          <option value="double_mean_v1">二倍均值法</option>
          <option value="bounded_mean_v1">均值上下 50%</option>
        </select>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={money.distributeFullPool}
          disabled={disabled}
          onChange={(event) =>
            onMoney({ ...money, distributeFullPool: event.target.checked })
          }
        />
        <span>
          <span className="font-medium">人数不足时发完奖池</span>
          <span className="mt-1 block text-xs leading-5 text-neutral-500">
            默认开启。关闭后仍按原获奖名额生成奖池，再从中随机抽取实际中奖人数对应的份数发放。
          </span>
        </span>
      </label>
    </div>
  );
}
