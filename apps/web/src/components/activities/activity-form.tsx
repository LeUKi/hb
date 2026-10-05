import {
  ACTIVITY_LIMITS,
  type ActivityInput,
  type ActivityIssue,
  activityInputSchema,
  byteLength,
  type CreateActivityInput,
  emptyActivityInput,
  formatAmount,
  type LdcActivityInput,
  ldcMoneySchema,
  ldcRewardCount,
  ldcTotalMinor,
  type ManagedActivity,
  newActivityInputSchema,
  type TextActivityInput,
} from "@hb/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { Link, useBlocker } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActivityRequestError, useActivityWrites } from "../../lib/activities";
import { useActivityOpening } from "../../lib/activity-opening";
import { useMerchant } from "../../lib/merchants";
import { Button } from "../ui/button";
import { LdcFields } from "./ldc-fields";
import { MarkdownField } from "./markdown";

type ActivityFormValues = Omit<TextActivityInput, "rewardType"> & {
  rewardType: "text" | "ldc";
  merchantId: string;
  money: LdcActivityInput["money"];
};

function formValues(input?: ActivityInput): ActivityFormValues {
  return {
    ...emptyActivityInput(),
    passwords: [""],
    rewards: [{ id: crypto.randomUUID(), text: "" }],
    merchantId: "",
    money: { mode: "fixed", totalAmount: "", count: 1 },
    ...input,
    quantityVisibility:
      input?.quantityVisibility === "hidden" ||
      input?.quantityVisibility === "availability"
        ? "exact"
        : (input?.quantityVisibility ?? "exact"),
  };
}

function activityValues(input: ActivityFormValues): ActivityInput {
  const { merchantId, money, rewards, rewardType, ...shared } = input;
  return rewardType === "ldc"
    ? {
        ...shared,
        rewardType,
        merchantId,
        money,
        allocation: money.mode === "random" ? "random" : shared.allocation,
      }
    : { ...shared, rewardType, rewards };
}

function localDateTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const two = (value: number) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    two(date.getMonth() + 1) +
    "-" +
    two(date.getDate()) +
    "T" +
    two(date.getHours()) +
    ":" +
    two(date.getMinutes())
  );
}

export function ActivityForm({
  userId,
  csrfToken,
  initial,
  onSaved,
}: {
  userId: string;
  csrfToken: string;
  initial?: ManagedActivity;
  onSaved: (activity: ManagedActivity) => void;
}) {
  const [persisted, setPersisted] = useState(initial);
  const [defaultValues, setDefaultValues] = useState(() =>
    formValues(initial?.config),
  );
  const [ldcVisited, setLdcVisited] = useState(
    defaultValues.rewardType === "ldc",
  );
  const rewardAllocations = useRef<
    Record<"text" | "ldc", TextActivityInput["allocation"]>
  >({
    text:
      defaultValues.rewardType === "text"
        ? defaultValues.allocation
        : "sequential",
    ldc:
      defaultValues.rewardType === "ldc"
        ? defaultValues.allocation
        : "sequential",
  });
  const [passwordIds, setPasswordIds] = useState(() =>
    defaultValues.passwords.map(() => crypto.randomUUID()),
  );
  const [issues, setIssues] = useState<ActivityIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertainRequest, setUncertainRequest] = useState<{
    request: CreateActivityInput;
    openAfter: boolean;
  } | null>(null);
  const [bulkText, setBulkText] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  const moreSettings = useRef<HTMLDetailsElement>(null);
  const submitIntent = useRef(true);
  const savedNavigation = useRef(false);
  const writes = useActivityWrites(userId, csrfToken, persisted?.id);
  const opening = useActivityOpening(userId, csrfToken);
  const opened = persisted !== undefined && persisted.status !== "draft";
  const ended =
    persisted?.status === "ended" || persisted?.status === "archived";
  const historicalPasswords = (persisted?.config.passwords.length ?? 0) > 5;
  const busy =
    writes.create.isPending || writes.update.isPending || opening.isPending;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function showIssues(nextIssues: ActivityIssue[]) {
    setIssues(nextIssues);
    const first = nextIssues[0]?.path.replace(/^activity\./, "").split(".")[0];
    if (
      first &&
      [
        "forceDedicated",
        "deadline",
        "beforeInfo",
        "afterClaimInfo",
        "afterEndInfo",
      ].includes(first) &&
      moreSettings.current
    )
      moreSettings.current.open = true;
    requestAnimationFrame(() =>
      document.getElementById("activity-errors")?.focus(),
    );
  }

  async function save(
    values: ActivityInput,
    openAfter: boolean,
    retry?: CreateActivityInput,
  ) {
    if (inFlight.current) return;
    if (values.rewardType === "text" && bulkText.trim()) {
      setMessage("批量输入区还有未添加的奖励，请先添加这些奖励。");
      return;
    }
    setMessage(null);
    setIssues([]);
    const payload = retry ?? {
      requestId: crypto.randomUUID(),
      activity: values,
    };
    const request = persisted
      ? { version: persisted.version, activity: values }
      : payload;
    if (byteLength(JSON.stringify(request)) > ACTIVITY_LIMITS.requestBytes) {
      setMessage("提交内容超过 1 MiB，请减少奖励或说明的内容后再保存。");
      return;
    }
    inFlight.current = true;
    savedNavigation.current = false;
    let savedActivity: ManagedActivity | undefined;
    try {
      const result = persisted
        ? await writes.update.mutateAsync({
            version: persisted.version,
            activity: values,
          })
        : await writes.create.mutateAsync(payload);
      if (!active.current) return;
      savedActivity = result.activity;
      setPersisted(savedActivity);
      setUncertainRequest(null);
      const savedValues = formValues(savedActivity.config);
      setDefaultValues(savedValues);
      form.reset(savedValues);
      if (openAfter && savedActivity.status === "draft") {
        const openedActivity = await opening.open(savedActivity);
        if (!active.current) return;
        setPersisted(openedActivity);
        savedNavigation.current = true;
        onSaved(openedActivity);
      } else {
        savedNavigation.current = true;
        onSaved(savedActivity);
      }
    } catch (error) {
      if (
        !active.current ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        return;
      if (savedActivity) {
        setMessage(
          "草稿已保存。" +
            (error instanceof Error ? error.message : "开放未完成，请重试。"),
        );
      } else if (
        !persisted &&
        (!(error instanceof ActivityRequestError) || error.status >= 500)
      ) {
        setUncertainRequest({ request: payload, openAfter });
        setMessage("尚未确认保存结果，请重试原提交，避免重复创建活动。");
      } else {
        setUncertainRequest(null);
        setMessage(
          error instanceof Error ? error.message : "保存失败，请稍后重试。",
        );
        if (error instanceof ActivityRequestError && error.issues.length)
          showIssues(error.issues);
      }
    } finally {
      inFlight.current = false;
    }
  }

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = (
          persisted ? activityInputSchema : newActivityInputSchema
        ).safeParse(activityValues(value));
        return result.success
          ? undefined
          : result.error.issues.map((issue) => issue.message).join("；");
      },
    },
    onSubmitInvalid: ({ value }) => {
      const result = (
        persisted ? activityInputSchema : newActivityInputSchema
      ).safeParse(activityValues(value));
      if (!result.success)
        showIssues(
          result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
    },
    onSubmit: async ({ value }) => {
      const result = (
        persisted ? activityInputSchema : newActivityInputSchema
      ).safeParse(activityValues(value));
      if (result.success) await save(result.data, submitIntent.current);
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const isDirty = useStore(form.store, (state) => state.isDirty);
  const selectedMerchant = useMerchant(
    userId,
    values.rewardType === "ldc" ? values.merchantId : "",
  );
  const paymentMode =
    persisted?.paymentMode ?? selectedMerchant.data?.merchant.mode;
  const input = activityValues(values);
  const checkedMoney =
    values.rewardType === "ldc" ? ldcMoneySchema.safeParse(values.money) : null;
  const totalLdc =
    input.rewardType === "ldc" && checkedMoney?.success
      ? formatAmount(ldcTotalMinor({ ...input, money: checkedMoney.data }))
      : null;
  const rewardCount =
    input.rewardType === "text" ? input.rewards.length : ldcRewardCount(input);
  const dirty = isDirty || Boolean(bulkText) || Boolean(uncertainRequest);
  useBlocker({
    shouldBlockFn: () =>
      !savedNavigation.current &&
      dirty &&
      !window.confirm("还有未保存的活动内容，确定离开吗？"),
    enableBeforeUnload: () => dirty && !savedNavigation.current,
  });

  function appendBulkRewards() {
    const lines = bulkText
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const existing = values.rewards.filter((reward) => reward.text !== "");
    if (lines.length + existing.length > ACTIVITY_LIMITS.rewards) {
      setBulkError("添加后超过 1,000 份奖励，请减少批量内容。");
      return;
    }
    if (lines.some((line) => byteLength(line) > ACTIVITY_LIMITS.rewardBytes)) {
      setBulkError("批量内容中有奖励超过 16 KiB，请先修改。");
      return;
    }
    form.setFieldValue("rewards", [
      ...existing,
      ...lines.map((text) => ({ id: crypto.randomUUID(), text })),
    ]);
    setBulkText("");
    setBulkError(null);
  }

  function moveReward(index: number, offset: number) {
    const rewards = [...values.rewards];
    const target = index + offset;
    const source = rewards[index];
    const destination = rewards[target];
    if (!source || !destination) return;
    rewards[index] = destination;
    rewards[target] = source;
    form.setFieldValue("rewards", rewards);
  }

  function toggleRecipients(visible: boolean) {
    form.setFieldValue("showRecipientList", visible);
    form.setFieldValue("showRecipientUsername", visible);
    form.setFieldValue("showRecipientTime", visible);
    form.setFieldValue(
      "showRecipientAmount",
      visible && values.rewardType === "ldc",
    );
  }

  const pendingLabel =
    opening.phase === "checking"
      ? "正在检查凭证…"
      : opening.isPending
        ? "正在开放…"
        : "正在保存…";
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (busy || uncertainRequest) return;
        submitIntent.current = !opened;
        void form.handleSubmit();
      }}
    >
      {message ? (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {message}
        </p>
      ) : null}
      {issues.length ? (
        <div
          id="activity-errors"
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <p className="font-medium">请修改以下内容：</p>
          <ul className="mt-2 list-disc pl-5">
            {issues.map((issue) => (
              <li key={issue.path + issue.message}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <fieldset
        disabled={busy || Boolean(uncertainRequest)}
        className="activity-panel space-y-5"
      >
        <legend className="sr-only">活动与奖励</legend>
        <h2 className="text-lg font-semibold">活动与奖励</h2>
        <label className="activity-label" htmlFor="activity-title">
          活动标题
          <input
            id="activity-title"
            className="activity-input"
            value={values.title}
            onChange={(event) =>
              form.setFieldValue("title", event.target.value)
            }
          />
        </label>
        <label className="activity-label" htmlFor="activity-rewardType">
          奖励类型
          <select
            id="activity-rewardType"
            className="activity-input"
            value={values.rewardType}
            disabled={opened}
            onChange={(event) => {
              const rewardType = event.target.value === "ldc" ? "ldc" : "text";
              rewardAllocations.current[values.rewardType] = values.allocation;
              form.setFieldValue("rewardType", rewardType);
              form.setFieldValue(
                "allocation",
                rewardAllocations.current[rewardType],
              );
              if (rewardType === "ldc") setLdcVisited(true);
              if (!persisted && values.showRecipientList)
                form.setFieldValue("showRecipientAmount", rewardType === "ldc");
            }}
          >
            <option value="text">文本奖励</option>
            <option value="ldc">LDC</option>
          </select>
        </label>
        <div id="activity-passwords" className="space-y-3">
          <h3 className="font-medium">有效口令</h3>
          <p className="text-xs leading-5 text-neutral-500">
            每条 6–18 个字符，仅限汉字、英文字母和数字，区分大小写；最多 5
            条，共享奖励池。
          </p>
          {historicalPasswords ? (
            <p className="text-xs text-neutral-600">
              保留历史口令集合，不能修改或继续添加。
            </p>
          ) : null}
          {values.passwords.map((password, index) => (
            <div key={passwordIds[index]} className="flex items-center gap-2">
              <input
                aria-label={`口令 ${index + 1}`}
                className="activity-input"
                value={password}
                autoComplete="off"
                spellCheck={false}
                disabled={
                  historicalPasswords ||
                  (opened && index < (persisted?.config.passwords.length ?? 0))
                }
                onChange={(event) =>
                  form.setFieldValue(
                    "passwords",
                    values.passwords.map((item, current) =>
                      current === index ? event.target.value : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="secondary"
                aria-label={`删除口令 ${index + 1}`}
                disabled={
                  historicalPasswords ||
                  (opened && index < (persisted?.config.passwords.length ?? 0))
                }
                onClick={() => {
                  setPasswordIds((ids) =>
                    ids.filter((_, current) => current !== index),
                  );
                  form.setFieldValue(
                    "passwords",
                    values.passwords.filter((_, current) => current !== index),
                  );
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            disabled={values.passwords.length >= 5 || historicalPasswords}
            onClick={() => {
              setPasswordIds((ids) => [...ids, crypto.randomUUID()]);
              form.setFieldValue("passwords", [...values.passwords, ""]);
            }}
          >
            <Plus className="size-4" />
            添加口令
          </Button>
        </div>
        {ldcVisited ? (
          <div hidden={values.rewardType !== "ldc"}>
            <LdcFields
              userId={userId}
              paymentMode={paymentMode}
              lockedPaymentMode={persisted?.paymentMode}
              autoBindCurrent={persisted?.config.rewardType !== "ldc"}
              merchantId={values.merchantId}
              money={values.money}
              allocation={values.allocation}
              disabled={opened || values.rewardType !== "ldc"}
              onMerchant={(value) => form.setFieldValue("merchantId", value)}
              onMoney={(value) => form.setFieldValue("money", value)}
              onAllocation={(value) => form.setFieldValue("allocation", value)}
            />
          </div>
        ) : null}
        {values.rewardType === "text" ? (
          <div className="space-y-5">
            <label className="activity-label" htmlFor="activity-allocation">
              奖励方式
              <select
                id="activity-allocation"
                className="activity-input"
                value={values.allocation}
                disabled={opened}
                onChange={(event) =>
                  form.setFieldValue(
                    "allocation",
                    event.target.value === "random" ? "random" : "sequential",
                  )
                }
              >
                <option value="sequential">按顺序领取</option>
                <option value="random">随机领取，不放回</option>
              </select>
            </label>
            <div className="space-y-3" id="activity-rewards">
              {values.rewards.map((reward, index) => (
                <div
                  key={reward.id}
                  className="space-y-2 rounded-md border border-neutral-200 p-3"
                >
                  <label className="activity-label">
                    {`奖励 ${index + 1}`}
                    <textarea
                      aria-label={`奖励 ${index + 1}`}
                      className="activity-input min-h-24"
                      value={reward.text}
                      disabled={opened}
                      onChange={(event) =>
                        form.setFieldValue(
                          "rewards",
                          values.rewards.map((item, current) =>
                            current === index
                              ? { ...item, text: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  {!opened ? (
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        aria-label={`上移奖励 ${index + 1}`}
                        disabled={index === 0}
                        onClick={() => moveReward(index, -1)}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        aria-label={`下移奖励 ${index + 1}`}
                        disabled={index === values.rewards.length - 1}
                        onClick={() => moveReward(index, 1)}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        aria-label={`删除奖励 ${index + 1}`}
                        onClick={() =>
                          form.setFieldValue(
                            "rewards",
                            values.rewards.filter(
                              (_, current) => current !== index,
                            ),
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
              {!opened ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={values.rewards.length >= ACTIVITY_LIMITS.rewards}
                    onClick={() =>
                      form.setFieldValue("rewards", [
                        ...values.rewards,
                        { id: crypto.randomUUID(), text: "" },
                      ])
                    }
                  >
                    <Plus className="size-4" />
                    添加奖励
                  </Button>
                  <details className="rounded-md border border-neutral-200 p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      批量添加奖励
                    </summary>
                    <div className="mt-3 space-y-3">
                      <label className="activity-label">
                        批量添加：每行一份
                        <textarea
                          aria-label="批量添加：每行一份"
                          className="activity-input min-h-28"
                          value={bulkText}
                          onChange={(event) => {
                            setBulkText(event.target.value);
                            setBulkError(null);
                          }}
                        />
                      </label>
                      {bulkError ? (
                        <p role="alert" className="text-sm text-red-700">
                          {bulkError}
                        </p>
                      ) : null}
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={!bulkText.trim()}
                        onClick={appendBulkRewards}
                      >
                        添加这些奖励
                      </Button>
                    </div>
                  </details>
                </>
              ) : null}
              <p className="text-xs text-neutral-500">
                最多 1,000 份，每份最多 16 KiB。相同文本保留为不同奖励。
              </p>
            </div>
          </div>
        ) : null}
      </fieldset>

      <fieldset
        disabled={busy || Boolean(uncertainRequest)}
        className="activity-panel space-y-5"
      >
        <legend className="sr-only">展示设置</legend>
        <h2 className="text-lg font-semibold">展示设置</h2>
        <label className="activity-label" htmlFor="activity-topicUrl">
          关联帖子或回复
          <input
            id="activity-topicUrl"
            type="url"
            className="activity-input"
            value={values.topicUrl}
            placeholder="https://linux.do/t/…/主题ID/楼层"
            onChange={(event) =>
              form.setFieldValue("topicUrl", event.target.value)
            }
          />
          <span className="text-xs font-normal text-neutral-500">
            选填，可精确定位回复，开放后仍可修改。
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            id="activity-joinSquare"
            type="checkbox"
            checked={values.joinSquare}
            disabled={
              persisted?.config.joinSquare === true || !values.topicUrl.trim()
            }
            onChange={(event) =>
              form.setFieldValue("joinSquare", event.target.checked)
            }
          />
          加入活动广场
        </label>
        <label className="activity-label" htmlFor="activity-quantityVisibility">
          数量展示
          <select
            id="activity-quantityVisibility"
            className="activity-input"
            value={values.quantityVisibility}
            onChange={(event) => {
              if (
                event.target.value === "exact" ||
                event.target.value === "fuzzy"
              )
                form.setFieldValue("quantityVisibility", event.target.value);
            }}
          >
            <option value="exact">精确数量</option>
            <option value="fuzzy">模糊数量</option>
          </select>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            aria-label="展示领取名单"
            className="mt-1 size-4"
            checked={values.showRecipientList}
            onChange={(event) => toggleRecipients(event.target.checked)}
          />
          <span>
            <span className="font-medium">展示领取名单</span>
            <span className="mt-1 block text-xs leading-5 text-neutral-500">
              用户名、领取时间{values.rewardType === "ldc" ? "和发放金额" : ""}
              一起展示；文本奖励正文保持私有。
            </span>
          </span>
        </label>
      </fieldset>

      <details ref={moreSettings} className="activity-panel">
        <summary className="cursor-pointer font-medium">更多设置</summary>
        <fieldset
          disabled={busy || Boolean(uncertainRequest)}
          className="mt-5 space-y-5"
        >
          <legend className="sr-only">更多设置</legend>
          <label className="flex items-start gap-3 text-sm">
            <input
              id="activity-forceDedicated"
              type="checkbox"
              className="mt-1 size-4 shrink-0"
              checked={values.forceDedicated}
              disabled={persisted !== undefined}
              onChange={(event) =>
                form.setFieldValue("forceDedicated", event.target.checked)
              }
            />
            <span>
              <span className="font-medium">强制专属页兑换</span>
              <span className="mt-1 block text-xs leading-5 text-neutral-500">
                禁止全站口令匹配，记录专属页尝试。首次保存后不可修改。
              </span>
            </span>
          </label>
          <label className="activity-label" htmlFor="activity-deadline">
            活动期限
            <select
              id="activity-deadline"
              className="activity-input"
              value={values.deadline.mode}
              disabled={opened}
              onChange={(event) =>
                form.setFieldValue(
                  "deadline",
                  event.target.value === "duration"
                    ? { mode: "duration" }
                    : {
                        mode: "at",
                        at: new Date(Date.now() + 86_400_000).toISOString(),
                      },
                )
              }
            >
              <option value="duration">正式开放后 24 小时</option>
              <option value="at">指定截止时间</option>
            </select>
          </label>
          {values.deadline.mode === "at" || opened ? (
            <label className="activity-label" htmlFor="activity-deadline-at">
              截止时间
              <input
                id="activity-deadline-at"
                type="datetime-local"
                className="activity-input"
                disabled={ended}
                value={localDateTime(
                  values.deadline.mode === "at"
                    ? values.deadline.at
                    : (persisted?.deadlineAt ?? ""),
                )}
                onChange={(event) => {
                  const date = new Date(event.target.value);
                  form.setFieldValue("deadline", {
                    mode: "at",
                    at: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
                  });
                }}
              />
              <span className="text-xs font-normal text-neutral-500">
                使用当前设备时区。开放后只可延长，结束后不能重新开放。
              </span>
            </label>
          ) : null}
          <MarkdownField
            id="activity-beforeInfo"
            label="领取前说明"
            value={values.beforeInfo}
            onChange={(value) => form.setFieldValue("beforeInfo", value)}
          />
          <MarkdownField
            id="activity-afterClaimInfo"
            label="领取后说明"
            value={values.afterClaimInfo}
            onChange={(value) => form.setFieldValue("afterClaimInfo", value)}
          />
          <MarkdownField
            id="activity-afterEndInfo"
            label="结束后说明"
            value={values.afterEndInfo}
            onChange={(value) => form.setFieldValue("afterEndInfo", value)}
          />
        </fieldset>
      </details>

      <section className="activity-panel space-y-4" aria-label="活动摘要">
        <p className="text-sm">
          {rewardCount} 份{input.rewardType === "ldc" ? " LDC" : "文本奖励"}
          {totalLdc ? ` · 总发放金额 ${totalLdc} LDC` : ""}
        </p>
        <p className="text-xs text-neutral-600">
          {values.deadline.mode === "duration"
            ? "开放后 24 小时截止"
            : "按指定截止时间结束"}{" "}
          ·{" "}
          {values.quantityVisibility === "exact"
            ? "精确数量"
            : values.quantityVisibility === "fuzzy"
              ? "模糊数量"
              : "保留原数量设置"}{" "}
          · {values.showRecipientList ? "展示领取名单" : "不展示名单"}
        </p>
        {persisted && !initial ? (
          <Link
            to="/my/activities/$id"
            params={{ id: persisted.id }}
            className="inline-block text-sm underline"
          >
            查看已保存活动
          </Link>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {uncertainRequest ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void save(
                  uncertainRequest.request.activity,
                  uncertainRequest.openAfter,
                  uncertainRequest.request,
                )
              }
            >
              {busy ? pendingLabel : "重试原提交"}
            </Button>
          ) : (
            <>
              <Button
                type="submit"
                disabled={
                  busy ||
                  (values.rewardType === "text" && Boolean(bulkText.trim()))
                }
              >
                {busy ? pendingLabel : opened ? "保存修改" : "保存并开放"}
              </Button>
              {!opened ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    busy ||
                    (values.rewardType === "text" && Boolean(bulkText.trim()))
                  }
                  onClick={() => {
                    submitIntent.current = false;
                    void form.handleSubmit();
                  }}
                >
                  保存草稿
                </Button>
              ) : null}
            </>
          )}
        </div>
      </section>
    </form>
  );
}
