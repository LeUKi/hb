import {
  ACTIVITY_LIMITS,
  type ActivityInput,
  amountToMinor,
  DEFAULT_DRAW_COUNTDOWN_SECONDS,
  formatAmount,
  moneySchema,
  type PaymentMode,
  type TimedDrawMoney,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { type MutableRefObject, useEffect, useState } from "react";
import { activityToolsEnabled } from "../../lib/activity-tools-release";
import { useMerchant, useMerchants } from "../../lib/merchants";
import { publicationReason } from "../../lib/payment-display";
import {
  formatCountdownSeconds,
  isTimedDrawMoney,
  localDateTime,
  timedDrawSummary,
  timedDrawTimeLabel,
  type WebLdcMoney,
} from "../../lib/timed-draw";
import { AnimatedRegion } from "../presentation/animated-disclosure";
import { Help } from "../presentation/context-help";
import { SegmentedControl } from "../presentation/list-controls";
import { Button } from "../ui/button";
import { ActivityErrorView } from "./activity-error";
import { RandomMoneySummary } from "./random-money-summary";
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

export type LdcDrafts = {
  fixedUnit: string;
  fixedCount: number;
  fixedNeedsAmount: boolean;
  randomVisited: boolean;
  random: {
    algorithm: "double_mean_v1" | "bounded_mean_v1";
    totalAmount: string;
    count: number;
  };
  customAllocation: "sequential" | "random";
  amounts: string[];
  timedDrawVisited: boolean;
  timedDraw: TimedDrawMoney;
  timedDrawDeadline: ActivityInput["deadline"];
  timedDrawCountdownSeconds: number;
  timedDrawAt: string;
};

export function createLdcDrafts(
  money: WebLdcMoney,
  allocation: "sequential" | "random",
  deadline: ActivityInput["deadline"],
): LdcDrafts {
  const initialSeed =
    money.mode === "custom"
      ? { totalAmount: "", count: Math.max(1, money.amounts.length) }
      : { totalAmount: money.totalAmount, count: money.count };
  return {
    fixedUnit: fixedUnitAmount(money),
    fixedCount: money.mode === "custom" ? money.amounts.length : money.count,
    fixedNeedsAmount: money.mode !== "fixed" && !fixedUnitAmount(money),
    randomVisited: money.mode === "random",
    random:
      money.mode === "random"
        ? {
            algorithm: money.algorithm,
            totalAmount: money.totalAmount,
            count: money.count,
          }
        : {
            algorithm: "double_mean_v1",
            ...initialSeed,
          },
    customAllocation: money.mode === "custom" ? allocation : "sequential",
    amounts: money.mode === "custom" ? money.amounts : [""],
    timedDrawVisited: isTimedDrawMoney(money),
    timedDrawDeadline: isTimedDrawMoney(money)
      ? deadline
      : { mode: "duration" },
    timedDrawCountdownSeconds:
      isTimedDrawMoney(money) && money.countdownSeconds !== undefined
        ? money.countdownSeconds
        : DEFAULT_DRAW_COUNTDOWN_SECONDS,
    timedDrawAt:
      isTimedDrawMoney(money) && deadline.mode === "at" ? deadline.at : "",
    timedDraw: isTimedDrawMoney(money)
      ? money
      : {
          mode: "timed_draw",
          algorithm: "double_mean_v1",
          totalAmount: initialSeed.totalAmount,
          count: initialSeed.count,
          participantLimit: null,
          countdownSeconds: DEFAULT_DRAW_COUNTDOWN_SECONDS,
          distributeFullPool: true,
        },
  };
}

export function LdcFields({
  userId,
  merchantId,
  money,
  deadline,
  deadlineAt,
  allocation,
  disabled,
  paymentMode,
  lockedPaymentMode,
  autoBindCurrent,
  onMerchant,
  onMoney,
  onDeadline,
  onAllocation,
  drafts,
}: {
  userId: string;
  merchantId: string;
  money: WebLdcMoney;
  deadline: ActivityInput["deadline"];
  deadlineAt?: string;
  allocation: "sequential" | "random";
  disabled: boolean;
  paymentMode?: PaymentMode;
  lockedPaymentMode?: PaymentMode;
  autoBindCurrent: boolean;
  onMerchant: (id: string) => void;
  onMoney: (money: WebLdcMoney) => void;
  onDeadline: (deadline: ActivityInput["deadline"]) => void;
  onAllocation: (allocation: "sequential" | "random") => void;
  drafts: MutableRefObject<LdcDrafts>;
}) {
  const [unitAmount, setUnitAmount] = useState(() => drafts.current.fixedUnit);
  const fixedNeedsAmount = drafts.current.fixedNeedsAmount;
  const plan = isTimedDrawMoney(money)
    ? "timed_draw"
    : money.mode === "fixed"
      ? "fixed"
      : money.mode === "random"
        ? "random"
        : "custom";
  const planLabels = {
    fixed: "固定均分",
    random: "即时随机",
    custom: "自定义金额",
    timed_draw: "限时开奖",
  } as const;
  useEffect(() => {
    if (money.mode === "fixed") {
      drafts.current.fixedUnit = unitAmount;
      drafts.current.fixedCount = money.count;
    } else if (money.mode === "random") {
      drafts.current.randomVisited = true;
      drafts.current.random = {
        algorithm: money.algorithm,
        totalAmount: money.totalAmount,
        count: money.count,
      };
    } else if (money.mode === "custom") {
      drafts.current.amounts = money.amounts;
      drafts.current.customAllocation = allocation;
    } else if (isTimedDrawMoney(money)) {
      drafts.current.timedDraw = money;
      drafts.current.timedDrawVisited = true;
      drafts.current.timedDrawDeadline = deadline;
      if (deadline.mode === "at") drafts.current.timedDrawAt = deadline.at;
      else if (money.countdownSeconds !== undefined)
        drafts.current.timedDrawCountdownSeconds = money.countdownSeconds;
    }
  }, [allocation, deadline, drafts, money, unitAmount]);
  function rememberCurrentPlan() {
    if (money.mode === "custom") {
      drafts.current.amounts = money.amounts;
      drafts.current.customAllocation = allocation;
    } else if (isTimedDrawMoney(money)) {
      drafts.current.timedDraw = money;
      drafts.current.timedDrawVisited = true;
      drafts.current.timedDrawDeadline = deadline;
      if (deadline.mode === "at") drafts.current.timedDrawAt = deadline.at;
      else if (money.countdownSeconds !== undefined)
        drafts.current.timedDrawCountdownSeconds = money.countdownSeconds;
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
            participantLimit: null,
          } satisfies TimedDrawMoney);
      drafts.current.timedDraw = draft;
      drafts.current.timedDrawVisited = true;
      onMoney(draft);
      onDeadline(drafts.current.timedDrawDeadline);
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
    <div>
      {paymentMode === "simulation" ? <SimulationNotice /> : null}
      {lockedPaymentMode ? (
        <p className="work-field-hint">
          付款模式已固定，草稿只能明确改用同模式的当前商户。
        </p>
      ) : null}
      {merchants.isError ? (
        <ActivityErrorView
          error={merchants.error}
          retry={() => merchants.refetch()}
        />
      ) : (
        <label className="field" htmlFor="activity-merchantId">
          发放商户
          <input
            id="activity-merchantId"
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
      <div id="activity-merchant-help" className="work-field-hint">
        {disabled ? (
          <p>活动发放商户已固定。凭证更新不改变奖励金额或收款人。</p>
        ) : notCurrent ? (
          <>
            <p className="work-setting-notice">
              草稿保留原商户，不会自动切换。开放新的 LDC 活动须使用当前商户。
            </p>
            {current ? (
              <>
                <p>
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
                  <p className="work-setting-notice">
                    当前商户付款模式与草稿不一致，不能重新绑定。
                  </p>
                )}
                <p>重新绑定仅在保存后生效，不改变已生成的金额库存。</p>
              </>
            ) : (
              <p>请先配置当前商户。</p>
            )}
          </>
        ) : selected ? (
          selected.publicationEligibility.reason !==
          "MERCHANT_CREDENTIALS_UNVERIFIED" ? (
            <p>
              {selected.publicationEligibility.allowed
                ? "当前商户可用于开放新的 LDC 活动。"
                : publicationReason(selected.publicationEligibility.reason)}
            </p>
          ) : null
        ) : merchants.isSuccess ? (
          <p>请先配置当前商户，再保存 LDC 活动。文本活动不需要商户。</p>
        ) : null}
      </div>
      {!disabled ? (
        <div className="work-inline-meta">
          <Link to="/my/merchants" className="work-text-link">
            管理商户
          </Link>
        </div>
      ) : null}
      <div className="work-title-group work-reward-heading">
        <h3>奖励方式</h3>
        <Help label="奖励方式">
          <p>
            <strong>{planLabels.fixed}：</strong>
            设置每份金额和奖励份数，每人领取相同金额。
          </p>
          <hr className="context-help-separator" />
          <p>
            <strong>{planLabels.random}：</strong>
            设置总金额和份数，按所选算法随机分配，每份只发放一次。
          </p>
          <hr className="context-help-separator" />
          <p>
            <strong>{planLabels.custom}：</strong>
            每行填写一份金额，按顺序或随机发放。
          </p>
          <hr className="context-help-separator" />
          <p>
            <strong>{planLabels.timed_draw}：</strong>
            报名达到上限或最晚开奖时间到达后开奖，中奖人数不超过设置的获奖名额。
          </p>
        </Help>
      </div>
      <div className="field" id="activity-money">
        <SegmentedControl
          className="work-plan-switch"
          label="奖励方式"
          value={plan}
          onChange={(value) => choosePlan(value)}
          options={[
            { value: "fixed", label: planLabels.fixed, disabled },
            { value: "random", label: planLabels.random, disabled },
            { value: "custom", label: planLabels.custom, disabled },
            { value: "timed_draw", label: planLabels.timed_draw, disabled },
          ]}
        />
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        {plan === "timed_draw" && isTimedDrawMoney(money) ? (
          <AnimatedRegion key="timed-draw" className="work-animated-section">
            <TimedDrawFields
              money={money}
              deadline={deadline}
              deadlineAt={deadlineAt}
              disabled={disabled}
              drafts={drafts}
              onDeadline={onDeadline}
              onMoney={(next) => {
                drafts.current.timedDraw = next;
                drafts.current.timedDrawVisited = true;
                onMoney(next);
              }}
            />
          </AnimatedRegion>
        ) : money.mode === "custom" ? (
          <AnimatedRegion key="custom" className="work-animated-section">
            <label className="field" htmlFor="ldc-amounts">
              每份金额（每行一个）
              <textarea
                id="ldc-amounts"
                aria-label="每份金额（每行一个）"
                value={money.amounts.join("\n")}
                disabled={disabled}
                onChange={(event) => {
                  const amounts = event.target.value.split(/\r?\n/);
                  drafts.current.amounts = amounts;
                  onMoney({ mode: "custom", amounts });
                }}
              />
            </label>
            <div className="field" id="ldc-custom-allocation">
              <span>发放顺序</span>
              <SegmentedControl
                label="发放顺序"
                value={allocation}
                onChange={(value) => {
                  drafts.current.customAllocation = value;
                  onAllocation(value);
                }}
                options={[
                  { value: "sequential", label: "按顺序领取", disabled },
                  { value: "random", label: "随机领取", disabled },
                ]}
              />
            </div>
          </AnimatedRegion>
        ) : (
          <AnimatedRegion key={money.mode} className="work-animated-section">
            <div className="work-field-grid">
              <label className="field" htmlFor="ldc-total">
                {money.mode === "fixed" ? "每份金额（LDC）" : "总奖池（LDC）"}
                <input
                  id="ldc-total"
                  inputMode="decimal"
                  value={
                    money.mode === "fixed" ? unitAmount : money.totalAmount
                  }
                  disabled={disabled}
                  onChange={(event) => {
                    if (money.mode === "fixed") {
                      drafts.current.fixedUnit = event.target.value;
                      setUnitAmount(event.target.value);
                      onMoney({
                        ...money,
                        totalAmount: fixedTotal(
                          event.target.value,
                          money.count,
                        ),
                      });
                    } else {
                      drafts.current.random = {
                        algorithm: money.algorithm,
                        totalAmount: event.target.value,
                        count: money.count,
                      };
                      drafts.current.randomVisited = true;
                      onMoney({ ...money, totalAmount: event.target.value });
                    }
                  }}
                />
              </label>
              <label className="field" htmlFor="ldc-count">
                奖励份数
                <input
                  id="ldc-count"
                  type="number"
                  min={1}
                  max={ACTIVITY_LIMITS.rewards}
                  step={1}
                  value={money.count || ""}
                  disabled={disabled}
                  onChange={(event) => {
                    const count = Number(event.target.value);
                    if (money.mode === "fixed") {
                      drafts.current.fixedCount = count;
                      onMoney({
                        ...money,
                        count,
                        totalAmount: fixedTotal(unitAmount, count),
                      });
                    } else {
                      drafts.current.random = {
                        algorithm: money.algorithm,
                        totalAmount: money.totalAmount,
                        count,
                      };
                      drafts.current.randomVisited = true;
                      onMoney({ ...money, count });
                    }
                  }}
                />
              </label>
            </div>
            {money.mode === "random" ? (
              <div className="field" id="ldc-random-algorithm">
                <span>抽奖算法</span>
                <SegmentedControl
                  label="抽奖算法"
                  value={money.algorithm}
                  onChange={(value) => chooseRandomAlgorithm(value)}
                  options={[
                    { value: "double_mean_v1", label: "二倍均值法", disabled },
                    {
                      value: "bounded_mean_v1",
                      label: "均值上下 50%",
                      disabled,
                    },
                  ]}
                />
              </div>
            ) : null}
          </AnimatedRegion>
        )}
      </AnimatePresence>
      {isTimedDrawMoney(money) ? (
        <p className="work-setting-notice">
          {timedDrawSummary(money, deadline)}
        </p>
      ) : money.mode === "random" ? (
        <RandomMoneySummary money={money} />
      ) : null}
      {!isTimedDrawMoney(money) &&
      money.mode === "fixed" &&
      fixedNeedsAmount &&
      !unitAmount ? (
        <p className="work-setting-notice">
          原总额无法按份数精确均分为两位小数，请填写每份金额。
        </p>
      ) : null}
      <p className="work-field-hint">
        最多 1,000 份，每份至少 0.01
        LDC，金额最多两位小数。填写的是发放金额，领取者承担自己一侧手续费。作者不能领取自己的
        LDC 活动。
      </p>
      {amountLabel && !isTimedDrawMoney(money) ? (
        <p className="work-inline-meta">
          总发放金额：{amountLabel} LDC ·{" "}
          {money.mode === "custom" ? money.amounts.length : money.count} 份
        </p>
      ) : null}
    </div>
  );
}

function TimedDrawFields({
  money,
  deadline,
  deadlineAt,
  disabled,
  drafts,
  onMoney,
  onDeadline,
}: {
  money: TimedDrawMoney;
  deadline: ActivityInput["deadline"];
  deadlineAt?: string;
  disabled: boolean;
  drafts: MutableRefObject<LdcDrafts>;
  onMoney: (money: TimedDrawMoney) => void;
  onDeadline: (deadline: ActivityInput["deadline"]) => void;
}) {
  const participantLimit = money.participantLimit ?? "";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function chooseTimeMode(mode: "duration" | "at") {
    if (
      disabled ||
      deadline.mode === mode ||
      (mode === "at" && !activityToolsEnabled && deadline.mode === "duration")
    )
      return;
    if (mode === "duration") {
      if (deadline.mode === "at") drafts.current.timedDrawAt = deadline.at;
      onMoney({
        ...money,
        countdownSeconds: drafts.current.timedDrawCountdownSeconds,
      });
      onDeadline({ mode: "duration" });
    } else {
      if (money.countdownSeconds !== undefined)
        drafts.current.timedDrawCountdownSeconds = money.countdownSeconds;
      const { countdownSeconds: _countdownSeconds, ...absoluteMoney } = money;
      onMoney(absoluteMoney);
      onDeadline({ mode: "at", at: drafts.current.timedDrawAt });
    }
  }
  return (
    <div>
      <div className="work-field-grid">
        <label className="field" htmlFor="timed-total">
          总奖池（LDC）
          <input
            id="timed-total"
            inputMode="decimal"
            value={money.totalAmount}
            disabled={disabled}
            onChange={(event) =>
              onMoney({ ...money, totalAmount: event.target.value })
            }
          />
        </label>
        <label className="field" htmlFor="timed-count">
          获奖名额
          <input
            id="timed-count"
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
        <label className="field" htmlFor="timed-participant-limit">
          报名上限
          <input
            id="timed-participant-limit"
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
          <span className="work-field-hint">
            默认不限制报名人数；填写后，满员即提前开奖。
          </span>
        </label>
        <div className="field">
          <span>最晚开奖时间</span>
          <SegmentedControl
            label="最晚开奖时间"
            value={deadline.mode}
            onChange={chooseTimeMode}
            options={[
              { value: "duration", label: "倒计时", disabled },
              {
                value: "at",
                label: "指定时间",
                disabled:
                  disabled ||
                  (!activityToolsEnabled && deadline.mode === "duration"),
              },
            ]}
          />
          {deadline.mode === "duration" ? (
            <>
              <label htmlFor="timed-countdown">倒计时（秒）</label>
              <input
                id="timed-countdown"
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
              <span className="work-field-hint">
                默认 {DEFAULT_DRAW_COUNTDOWN_SECONDS} 秒（10 分钟）；当前设置：
                {formatCountdownSeconds(money.countdownSeconds)}。
              </span>
            </>
          ) : (
            <>
              <label htmlFor="timed-deadline-at">指定开奖时间</label>
              <input
                id="timed-deadline-at"
                type="datetime-local"
                value={localDateTime(deadline.at)}
                disabled={disabled}
                onChange={(event) => {
                  const date = new Date(event.target.value);
                  onDeadline({
                    mode: "at",
                    at: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
                  });
                }}
              />
              <span className="work-field-hint">
                使用当前设备时区（{timeZone}）。
              </span>
            </>
          )}
          {deadlineAt ? (
            <span className="work-field-hint">
              实际最晚开奖时间：
              {timedDrawTimeLabel(money, { mode: "at", at: deadlineAt })}
            </span>
          ) : null}
        </div>
      </div>
      <div className="field" id="timed-algorithm">
        <span>抽奖算法</span>
        <SegmentedControl
          label="抽奖算法"
          value={money.algorithm}
          onChange={(algorithm) => onMoney({ ...money, algorithm })}
          options={[
            { value: "double_mean_v1", label: "二倍均值法", disabled },
            { value: "bounded_mean_v1", label: "均值上下 50%", disabled },
          ]}
        />
      </div>
      <div className="work-toggle-row">
        <label className="work-toggle">
          <input
            id="timed-distribute-full-pool"
            type="checkbox"
            checked={money.distributeFullPool}
            disabled={disabled}
            aria-describedby="timed-distribute-full-pool-notice"
            onChange={(event) =>
              onMoney({ ...money, distributeFullPool: event.target.checked })
            }
          />
          <span className="work-toggle-control" aria-hidden="true" />
          <span className="work-toggle-copy">
            <strong>人数不足时发完奖池</strong>
          </span>
        </label>
        <span
          id="timed-distribute-full-pool-notice"
          className="work-setting-notice"
        >
          开启后，报名人数不足获奖名额时仍分配完整奖池。
        </span>
      </div>
    </div>
  );
}
