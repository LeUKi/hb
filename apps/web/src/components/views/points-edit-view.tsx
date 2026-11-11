// 配置三方积分 (/points/new, /points/$id/edit; docs/third-party-points-
// design.md §4 §6): every setting beside where it shows, with the site's own
// parts drawn as they will look; a 仿真 that walks each answer without a
// call; 接入自检 against the real endpoints; then 提交审核.
import {
  formatDisplayAmount,
  formatStep,
  isValidStep,
  nextStep,
  normalizePointsBaseUrl,
  POINTS_LIMITS,
  type PointsSystemConfig,
  parseUnitAmount,
  pointsPrivacyLine,
  pointsTagHint,
  stepDecimals,
} from "@hb/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CircleCheck,
  CircleX,
  KeyRound,
  Minus,
  Plus,
  UserRoundX,
  WalletCards,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  type PointsOwnerView,
  type SelfTestStep,
  statusWords,
  useOwnPoints,
  usePointsOwnerActions,
} from "../../lib/points";
import { clockLabel } from "../../lib/roster-time";
import { useSessionUser } from "../../lib/session";
import { amountText } from "../../lib/units";
import { Callout, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { LeaveGuard } from "../shell/leave-guard";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { Field, TextArea, TextInput } from "../ui/field";
import { NoteMarkdown } from "../ui/markdown";
import { PointsCapsule } from "../ui/points-mark";
import { Reveal } from "../ui/reveal";
import { StatusChip } from "../ui/status-chip";
import { PointsTag, statusTones } from "./points-view";

const empty: PointsSystemConfig = {
  name: "",
  unit: "",
  step: 100,
  issuerName: "",
  baseUrl: "https://",
  intro: "",
  keyGuide: "",
  noRecipient: "",
  arrival: "",
  notAllowed: "",
  insufficient: "",
  keyInvalid: "",
  rate: POINTS_LIMITS.rateDefault,
};

function configOf(system: PointsOwnerView): PointsSystemConfig {
  return {
    name: system.name,
    unit: system.unit,
    step: system.step,
    issuerName: system.issuerName,
    baseUrl: system.baseUrl,
    intro: system.intro,
    keyGuide: system.keyGuide,
    noRecipient: system.noRecipient,
    arrival: system.arrival,
    notAllowed: system.notAllowed,
    insufficient: system.insufficient,
    keyInvalid: system.keyInvalid,
    rate: system.rate,
  };
}

const same = (a: PointsSystemConfig, b: PointsSystemConfig) =>
  JSON.stringify(a) === JSON.stringify(b);

export function PointsEditView({ id }: { id?: string }) {
  const user = useSessionUser();
  const query = useOwnPoints(user?.id ?? "", id ?? "");
  if (!id) return <Editor />;
  return (
    <PageLoad load={queryLoad(query)}>
      {query.data && (
        <Editor
          key={`${query.data.system.id}:${query.data.system.version}`}
          system={query.data.system}
          tests={query.data.tests}
        />
      )}
    </PageLoad>
  );
}

function Editor({
  system,
  tests = [],
}: {
  system?: PointsOwnerView;
  tests?: {
    id: string;
    status: string;
    steps: SelfTestStep[];
    startedAt: number;
  }[];
}) {
  const user = useSessionUser();
  const navigate = useNavigate();
  const actions = usePointsOwnerActions(user?.id ?? "");
  const saved = system ? configOf(system) : empty;
  const [config, setConfig] = useState<PointsSystemConfig>(saved);
  const dirty = !same(config, saved);
  // Created: on to its 配置页 once the guard has let go of this one.
  const [created, setCreated] = useState<string | null>(null);
  useEffect(() => {
    if (created) void navigate({ href: `/points/${created}/edit` });
  }, [created, navigate]);
  const set = <K extends keyof PointsSystemConfig>(
    key: K,
    value: PointsSystemConfig[K],
  ) => setConfig((current) => ({ ...current, [key]: value }));
  const endpoint = normalizePointsBaseUrl(config.baseUrl);
  const host = endpoint.ok ? endpoint.host : "你的网站";
  const unit = { unit: config.unit || "积分", step: config.step };
  const save = system ? actions.update : actions.create;
  const saveError = save.error
    ? save.error instanceof ActivityRequestError
      ? save.error.message
      : "没有保存，请稍后再试。"
    : null;
  const endpointMoved =
    system !== undefined &&
    (config.baseUrl.replace(/\/+$/, "") !== system.baseUrl ||
      config.step !== system.step);
  const submit = () => {
    if (save.isPending) return;
    if (system)
      actions.update.mutate({
        id: system.id,
        version: system.version,
        config,
      });
    else
      actions.create.mutate(config, {
        onSuccess: ({ system: made }) => setCreated(made.id),
      });
  };
  const amount = amountText(config.step * 3, unit);
  return (
    <Page>
      <LeaveGuard
        when={dirty && created === null}
        message="积分的修改还没保存，确定离开吗？"
      />
      <PageHeader
        back={{ label: "三方积分", href: "/points" }}
        title={system ? `设置「${system.name}」` : "添加积分"}
        description="每一项旁边是它在红包站上的样子，只是预览，不会调用你的接口。说明文字改了马上生效；改接口地址或最小单位要先暂停，再重新测试、审核。"
        actions={
          <Link
            to="/help/points"
            className="text-sm text-accent-ink hover:underline"
          >
            接口说明
          </Link>
        }
      />
      {system && <StatusPart system={system} />}
      <PageSection title="基本信息">
        <Panel className="grid gap-5 p-4">
          <Row
            where="红包皮上的标签"
            preview={<TagPreview name={config.name || "名称"} host={host} />}
          >
            <Field
              label="名称"
              htmlFor="pt-name"
              hint={`最多 ${POINTS_LIMITS.nameMax} 个字`}
            >
              <TextInput
                id="pt-name"
                value={config.name}
                maxLength={POINTS_LIMITS.nameMax * 2}
                onChange={(event) => set("name", event.target.value)}
              />
            </Field>
          </Row>
          <Row
            where="红包上的金额"
            preview={
              <p className="text-sm leading-6 text-ink-2">
                每份至少 {amountText(config.step, unit)}
                <br />
                一份 {amount}
                <br />
                大的数会缩写：
                {amountText(
                  12_345_678_900 - (12_345_678_900 % config.step),
                  unit,
                )}
              </p>
            }
          >
            <Field
              label="单位"
              htmlFor="pt-unit"
              hint={`写在数量后面，最多 ${POINTS_LIMITS.unitWidthMax / 2} 个汉字或 ${POINTS_LIMITS.unitWidthMax} 个字母`}
            >
              <TextInput
                id="pt-unit"
                value={config.unit}
                maxLength={POINTS_LIMITS.unitWidthMax * 2}
                onChange={(event) => set("unit", event.target.value)}
              />
            </Field>
            <StepField
              value={config.step}
              onChange={(step) => set("step", step)}
              unit={config.unit || "积分"}
            />
          </Row>
          <Row
            where="积分的详情页"
            preview={
              <div className="grid gap-1.5">
                <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                  <PointsCapsule name={config.name || "名称"} />
                  {config.issuerName || "网站名称"}
                </span>
                <p className="text-sm text-ink-2">
                  {config.issuerName || "网站名称"}的积分，来自 {host}。
                </p>
              </div>
            }
          >
            <Field
              label="网站名称"
              htmlFor="pt-issuer"
              hint={`你网站的名字，最多 ${POINTS_LIMITS.issuerNameMax} 个字`}
            >
              <TextInput
                id="pt-issuer"
                value={config.issuerName}
                onChange={(event) => set("issuerName", event.target.value)}
              />
            </Field>
          </Row>
          <Row
            where="领取按钮下面"
            preview={
              <div
                className="grid gap-1 rounded-xl px-3 py-2.5 text-center"
                style={{
                  background:
                    "linear-gradient(var(--color-cover-top), var(--color-cover-bottom))",
                }}
              >
                <span className="text-sm font-semibold text-[var(--color-cream)]">
                  领取
                </span>
                <span className="text-xs text-[var(--color-cream-2)]">
                  {pointsPrivacyLine(host)}
                </span>
              </div>
            }
          >
            <Field
              label="接口地址"
              htmlFor="pt-base"
              hint="三个接口都在它下面：/balance、/transfer、/query。只能用 https"
              error={
                config.baseUrl.length > 8 && !endpoint.ok
                  ? endpoint.message
                  : undefined
              }
            >
              <TextInput
                id="pt-base"
                mono
                value={config.baseUrl}
                spellCheck={false}
                onChange={(event) => set("baseUrl", event.target.value)}
              />
            </Field>
            <Field
              label="每秒最多调用"
              htmlFor="pt-rate"
              hint={`红包站每秒最多调你的接口这么多次（1 到 ${POINTS_LIMITS.rateMax}），多出来的发放等一两秒再发。随时可以改`}
              error={
                config.rate < 1 || config.rate > POINTS_LIMITS.rateMax
                  ? `填 1 到 ${POINTS_LIMITS.rateMax}`
                  : undefined
              }
            >
              <TextInput
                id="pt-rate"
                inputMode="numeric"
                value={config.rate > 0 ? String(config.rate) : ""}
                onChange={(event) => {
                  const digits = event.target.value
                    .replace(/\D/g, "")
                    .slice(0, 3);
                  set("rate", digits ? Number(digits) : 0);
                }}
              />
            </Field>
          </Row>
        </Panel>
      </PageSection>
      <PageSection
        title="说明文字"
        description="都由你写，随时能改，马上生效；站长看得到每一次改动。不写的用红包站的默认说法。"
      >
        <Panel className="grid gap-5 p-4">
          <Row
            where="积分的详情页，任何人都能打开"
            preview={
              config.intro ? (
                <NoteMarkdown className="text-sm">{config.intro}</NoteMarkdown>
              ) : (
                <p className="text-sm text-ink-3">
                  不写，详情页就没有“介绍”这一节。
                </p>
              )
            }
          >
            <CopyField
              id="pt-intro"
              label="介绍"
              max={POINTS_LIMITS.introMax}
              value={config.intro}
              markdown
              onChange={(value) => set("intro", value)}
            />
          </Row>
          <Row
            where="发红包的人选了它、要填密钥时"
            preview={<KeyGuidePreview config={config} host={host} />}
          >
            <CopyField
              id="pt-key"
              label="怎么拿到密钥"
              max={POINTS_LIMITS.keyGuideMax}
              value={config.keyGuide}
              markdown
              onChange={(value) => set("keyGuide", value)}
            />
          </Row>
          <Row
            where="领取的人还没在你网站开户时，他的结果"
            preview={
              <NoRecipientPreview config={config} host={host} amount={amount} />
            }
          >
            <CopyField
              id="pt-none"
              label="领取的人还没开户时"
              max={POINTS_LIMITS.noRecipientMax}
              value={config.noRecipient}
              markdown
              note="也写在详情页的“怎么领到”里。"
              onChange={(value) => set("noRecipient", value)}
            />
          </Row>
          <Row
            where="领到以后，领取的人的结果"
            preview={<ArrivedPreview config={config} host={host} />}
          >
            <CopyField
              id="pt-arrival"
              label="到账后"
              max={POINTS_LIMITS.arrivalMax}
              value={config.arrival}
              onChange={(value) => set("arrival", value)}
            />
          </Row>
          <Row
            where="你的接口不让发给他时（回 not_allowed），领取的人的结果"
            preview={
              <div className="grid justify-items-center gap-1 text-center">
                <StatusChip tone="danger" dot>
                  未发出
                </StatusChip>
                <p className="text-sm text-ink-2">
                  {config.notAllowed || `${host} 不允许给你发这笔。`}
                </p>
              </div>
            }
          >
            <CopyField
              id="pt-denied"
              label="不能发给他时"
              max={POINTS_LIMITS.notAllowedMax}
              value={config.notAllowed}
              onChange={(value) => set("notAllowed", value)}
            />
          </Row>
          <Row
            where="发红包的人的余额不够、红包提前结束时，他的红包页"
            preview={
              <Callout
                tone="danger"
                icon={WalletCards}
                title="红包已经提前结束"
              >
                {config.insufficient ||
                  `你在 ${host} 的余额不够了，没发出的不再发。`}
              </Callout>
            }
          >
            <CopyField
              id="pt-short"
              label="余额不够时"
              max={POINTS_LIMITS.senderNoticeMax}
              value={config.insufficient}
              onChange={(value) => set("insufficient", value)}
            />
          </Row>
          <Row
            where="发红包的人的密钥失效、红包提前结束时，他的红包页"
            preview={
              <Callout
                tone="danger"
                icon={WalletCards}
                title="红包已经提前结束"
              >
                {config.keyInvalid ||
                  `${host} 说你的密钥失效了，没发出的不再发。`}
              </Callout>
            }
          >
            <CopyField
              id="pt-invalid"
              label="密钥失效时"
              max={POINTS_LIMITS.senderNoticeMax}
              value={config.keyInvalid}
              onChange={(value) => set("keyInvalid", value)}
            />
          </Row>
        </Panel>
      </PageSection>
      <div className="grid gap-2 px-1">
        <Reveal show={Boolean(saveError)}>
          <p role="alert" className="text-sm text-danger">
            {saveError}
          </p>
        </Reveal>
        <Reveal show={endpointMoved && system?.status === "online"}>
          <p className="text-sm text-warning">
            已上线时不能改接口地址或最小单位：先在上面暂停。
          </p>
        </Reveal>
        <div className="flex justify-end">
          <Button
            variant="primary"
            aria-disabled={
              save.isPending || (!dirty && system !== undefined) || undefined
            }
            onClick={() => {
              if (!dirty && system) return;
              submit();
            }}
          >
            {save.isPending
              ? "正在保存…"
              : system
                ? "保存"
                : "保存，接着测试接口"}
          </Button>
        </div>
      </div>
      {system && <SelfTest system={system} tests={tests} blocked={dirty} />}
    </Page>
  );
}

/**
 * One setting (or two that go together) and, beside it on a wide window and
 * under it on a phone, how it looks on 红包站 (§6).
 */
function Row({
  where,
  preview,
  children,
}: {
  where: string;
  preview: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid items-start gap-3 border-line border-b pb-5 last:border-b-0 last:pb-0 @wide/window:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @wide/window:gap-6">
      <div className="grid min-w-0 gap-4">{children}</div>
      <div className="grid min-w-0 gap-2 rounded-2xl border border-line border-dashed p-3">
        <p className="text-xs text-ink-3">预览 · {where}</p>
        {preview}
      </div>
    </div>
  );
}

/** 最小单位: typed as any multiple of 0.01, or stepped along 1-2-5 (§6). */
function StepField({
  value,
  onChange,
  unit,
}: {
  value: number;
  onChange: (step: number) => void;
  unit: string;
}) {
  const [text, setText] = useState(formatStep(value));
  useEffect(() => setText(formatStep(value)), [value]);
  const parsed = parseUnitAmount(text, 1);
  const valid = parsed !== null && isValidStep(parsed);
  const down = nextStep(value, -1);
  const up = nextStep(value, 1);
  const decimals = stepDecimals(value);
  const shown = { unit, step: value };
  return (
    <Field
      label="最小单位"
      htmlFor="pt-step"
      hint={`所有数量都是它的整数倍，显示${decimals ? `${decimals} 位小数` : "不带小数"}；接口测试会真的花掉 ${amountText(value, shown)}。`}
      error={valid ? undefined : "要在 0.01 到 1 亿之间，最多两位小数"}
    >
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          aria-label="减小最小单位"
          disabled={down === null}
          onClick={() => down !== null && onChange(down)}
        >
          <Minus />
        </Button>
        <TextInput
          id="pt-step"
          className="w-40"
          inputMode="decimal"
          value={text}
          suffix={unit}
          invalid={!valid}
          onChange={(event) => {
            setText(event.target.value);
            const next = parseUnitAmount(event.target.value, 1);
            if (next !== null && isValidStep(next)) onChange(next);
          }}
        />
        <Button
          variant="secondary"
          size="icon"
          aria-label="加大最小单位"
          disabled={up === null}
          onClick={() => up !== null && onChange(up)}
        >
          <Plus />
        </Button>
      </div>
    </Field>
  );
}

/** The cover's capsule and its bubble, as a 红包 shows them (§9). */
function TagPreview({ name, host }: { name: string; host: string }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <PointsTag name={name} />
      <span className="glass-pop max-w-60 rounded-xl px-3 py-2 text-[13px] leading-5 text-ink-2">
        {pointsTagHint(host)}
        <br />
        <span className="font-medium text-ink">查看详情 ›</span>
      </span>
    </div>
  );
}

function CopyField({
  id,
  label,
  max,
  value,
  markdown = false,
  note = "",
  onChange,
}: {
  id: string;
  label: string;
  max: number;
  value: string;
  markdown?: boolean;
  /** Where else it shows, said after the rest. */
  note?: string;
  onChange: (value: string) => void;
}) {
  const count = Array.from(value).length;
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={`${markdown ? "支持 Markdown：链接能点，图片不显示。" : ""}${note}`}
      aside={`${count} / ${max}`}
      error={count > max ? `最多 ${max} 个字` : undefined}
    >
      {markdown ? (
        <TextArea
          id={id}
          rows={4}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <TextInput
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/\n/g, " "))}
        />
      )}
    </Field>
  );
}

/** 填密钥 as the sender sees it, with the guide written here (§8). */
function KeyGuidePreview({
  config,
  host,
}: {
  config: PointsSystemConfig;
  host: string;
}) {
  const unit = { unit: config.unit || "积分", step: config.step };
  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-1.5 font-semibold text-ink">
        <KeyRound className="size-4" aria-hidden="true" />
        填你在 {host} 的密钥
      </p>
      {config.keyGuide ? (
        <NoteMarkdown className="text-sm">{config.keyGuide}</NoteMarkdown>
      ) : (
        <p className="text-sm text-ink-2">
          到 {host} 生成一把给红包站用的密钥，贴在下面。
        </p>
      )}
      <p className="text-sm text-ink-2">
        保存后：可用 {amountText(config.step * 1234, unit)}，将从 @某人 的账户扣
      </p>
    </div>
  );
}

/** 找不到收款人 on the claimant's result: words, resend, countdown (§5). */
function NoRecipientPreview({
  config,
  host,
  amount,
}: {
  config: PointsSystemConfig;
  host: string;
  amount: string;
}) {
  return (
    <Callout tone="warning" icon={UserRoundX} title={`你在 ${host} 还没有账户`}>
      <p>
        这笔 {amount}{" "}
        暂时发不出去。先在那边开好账户，再回来点“重新发送”：只能重新发送一次。
      </p>
      {config.noRecipient && (
        <NoteMarkdown className="mt-2 text-sm">
          {config.noRecipient}
        </NoteMarkdown>
      )}
      <div className="mt-2.5">
        <Button variant="primary" size="sm" tabIndex={-1}>
          重新发送
        </Button>
      </div>
      <p className="mt-2 text-xs">
        还剩 <Ticking /> 可以重新发送，过时不再补发。
      </p>
    </Callout>
  );
}

/** 已到账 on the claimant's result, with the words written here. */
function ArrivedPreview({
  config,
  host,
}: {
  config: PointsSystemConfig;
  host: string;
}) {
  const unit = { unit: config.unit || "积分", step: config.step };
  return (
    <div className="grid justify-items-center gap-1 text-center">
      <p className="text-2xl font-semibold text-success">
        +{shownOnly(config.step * 3, unit)}{" "}
        <span className="text-base font-medium">{unit.unit}</span>
      </p>
      <StatusChip tone="success" dot>
        已到账
      </StatusChip>
      <p className="text-sm text-ink-2">已存进你在 {host} 的账户。</p>
      {config.arrival && <p className="text-sm text-ink-2">{config.arrival}</p>}
    </div>
  );
}

const shownOnly = (minor: number, unit: { step: number }) =>
  formatDisplayAmount(minor, unit.step).text;

/** The resend countdown, ticking from 5:00 for the preview. */
function Ticking() {
  const [left, setLeft] = useState(300);
  useEffect(() => {
    const timer = window.setInterval(
      () => setLeft((value) => (value <= 0 ? 300 : value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="font-mono tabular-nums">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

/** Where it stands, and what its owner can do now (§1). */
function StatusPart({ system }: { system: PointsOwnerView }) {
  const user = useSessionUser();
  const actions = usePointsOwnerActions(user?.id ?? "");
  const [retiring, setRetiring] = useState(false);
  const act = actions.act;
  const error = act.error
    ? act.error instanceof ActivityRequestError
      ? act.error.message
      : "没有完成，请稍后再试。"
    : null;
  const run = (action: "submit" | "pause" | "resume" | "retire") => {
    if (act.isPending) return;
    act.mutate({ id: system.id, action });
  };
  return (
    <Panel className="grid gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <StatusChip tone={statusTones[system.status]}>
          {statusWords[system.status]}
        </StatusChip>
        <span>
          {system.status === "draft"
            ? system.passed
              ? "接口测试已通过，可以提交审核。"
              : "先通过下面的接口测试，再提交审核。"
            : system.status === "reviewing"
              ? "等站长审核。"
              : system.status === "online"
                ? `${system.onlineAt ? clockLabel(system.onlineAt) : ""} 上线，大家发红包时能选它。`
                : system.status === "paused"
                  ? system.pausedBy === "admin"
                    ? "站长暂停了它：现在不能用它发红包，领取也要等它恢复。"
                    : "你暂停了它：现在不能用它发红包，领取也要等它恢复。"
                  : "已经下架。"}
        </span>
      </div>
      {system.reviewNote && (
        <p className="text-sm text-ink-2">站长说：{system.reviewNote}</p>
      )}
      {system.status === "online" &&
        system.breakerUntil !== null &&
        system.breakerUntil > Date.now() && (
          <p className="text-sm text-warning">
            连续 5 次没收到你的接口的回复，暂停发放到{" "}
            {clockLabel(system.breakerUntil)}。
          </p>
        )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {system.status !== "retired" && (
        <div className="flex flex-wrap gap-2">
          {system.status === "draft" && (
            <Button
              size="sm"
              variant="primary"
              aria-disabled={!system.passed || act.isPending || undefined}
              onClick={() => system.passed && run("submit")}
            >
              提交审核
            </Button>
          )}
          {system.status === "online" && (
            <Button size="sm" onClick={() => run("pause")}>
              暂停
            </Button>
          )}
          {system.status === "paused" && system.pausedBy !== "admin" && (
            <Button size="sm" onClick={() => run("resume")}>
              恢复
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={() => setRetiring(true)}>
            下架
          </Button>
        </div>
      )}
      <RetireDialog
        open={retiring}
        name={system.name}
        busy={act.isPending}
        onClose={() => setRetiring(false)}
        onConfirm={() =>
          act.mutate(
            { id: system.id, action: "retire" },
            { onSuccess: () => setRetiring(false) },
          )
        }
      />
    </Panel>
  );
}

function RetireDialog({
  open,
  name,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  name: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      busy={busy}
    >
      <div className="grid gap-3 p-5">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          下架「{name}」？
        </h2>
        <p className="text-sm text-ink-2">
          下架以后不能再用它发红包，还开着的红包立即结束，没发出的不再发。下架不能撤回。
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            返回
          </Button>
          <Button
            variant="danger"
            aria-disabled={busy || undefined}
            onClick={() => !busy && onConfirm()}
          >
            {busy ? "正在下架…" : "下架"}
          </Button>
        </div>
      </div>
    </WindowDialog>
  );
}

/** 接入自检 (§4): eleven steps against the real endpoints, and the past runs. */
function SelfTest({
  system,
  tests,
  blocked,
}: {
  system: PointsOwnerView;
  tests: {
    id: string;
    status: string;
    steps: SelfTestStep[];
    startedAt: number;
  }[];
  blocked: boolean;
}) {
  const user = useSessionUser();
  const actions = usePointsOwnerActions(user?.id ?? "");
  const run = actions.selfTest;
  const [testKey, setTestKey] = useState("");
  const [recipient, setRecipient] = useState(system.testRecipientId ?? "");
  const latest =
    run.data?.test ??
    (tests[0]
      ? { passed: tests[0].status === "passed", steps: tests[0].steps }
      : null);
  const error = run.error
    ? run.error instanceof ActivityRequestError
      ? run.error.message
      : "测试没有完成，请稍后再试。"
    : null;
  const recipientId = Number(recipient);
  const ready =
    !blocked &&
    Number.isSafeInteger(recipientId) &&
    recipientId > 0 &&
    (system.hasTestKey || testKey.trim() !== "");
  return (
    <PageSection
      title="接口测试"
      description={`按顺序调用你的三个接口，一共会真的花掉 ${amountText(system.step, { unit: system.unit, step: system.step })}。测试期间测试账户不要有别的进出；两次测试至少隔 30 秒。`}
    >
      <Panel className="grid gap-4 p-4">
        <div className="grid gap-4 @wide/window:grid-cols-2">
          <Field
            label="测试密钥"
            htmlFor="pt-test-key"
            hint={
              system.hasTestKey
                ? "不填就用上次的（加密保存，只用于测试）"
                : "加密保存，只用于测试"
            }
          >
            <TextInput
              id="pt-test-key"
              type="password"
              autoComplete="off"
              value={testKey}
              onChange={(event) => setTestKey(event.target.value)}
            />
          </Field>
          <Field
            label="测试收款人的 LINUX DO ID"
            htmlFor="pt-test-to"
            hint="可以填自己，前提是你的接口允许自己转给自己"
          >
            <TextInput
              id="pt-test-to"
              inputMode="numeric"
              value={recipient}
              onChange={(event) =>
                setRecipient(event.target.value.replace(/\D/g, ""))
              }
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-ink-3">
            {blocked
              ? "先保存上面的修改，再测试。"
              : system.passed
                ? "这个接口地址和最小单位已经通过测试。"
                : "还没通过。"}
          </span>
          <Button
            variant="primary"
            aria-disabled={!ready || run.isPending || undefined}
            onClick={() => {
              if (!ready || run.isPending) return;
              run.mutate({
                id: system.id,
                ...(testKey.trim() ? { testKey: testKey.trim() } : {}),
                testRecipientId: recipientId,
              });
            }}
          >
            {run.isPending ? "正在测试…" : "开始测试"}
          </Button>
        </div>
        <Reveal show={run.isPending}>
          <p className="loading-sheen text-sm text-ink-2">
            正在依次调用你的接口，每一步最多等 10 秒。
          </p>
        </Reveal>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {latest && !run.isPending && (
          <ol className="grid gap-2">
            <li className="text-sm font-medium text-ink">
              {latest.passed ? "最近一次：全部通过" : "最近一次：没通过"}
            </li>
            {latest.steps.map((step) => (
              <StepRow key={step.n} step={step} />
            ))}
          </ol>
        )}
      </Panel>
    </PageSection>
  );
}

function StepRow({ step }: { step: SelfTestStep }) {
  const [open, setOpen] = useState(!step.ok);
  return (
    <li className="grid gap-1 rounded-xl bg-fill-2 px-3 py-2 text-sm">
      <button
        type="button"
        className="flex items-start gap-2 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        {step.ok ? (
          <CircleCheck
            className="mt-0.5 size-4 shrink-0 text-success"
            aria-hidden="true"
          />
        ) : (
          <CircleX
            className="mt-0.5 size-4 shrink-0 text-danger"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1 text-ink">
          {step.n}. {step.title}
        </span>
        <span className="shrink-0 text-xs text-ink-3 tabular-nums">
          {step.ms} ms
        </span>
      </button>
      {open && (step.sent || step.got) && (
        <div className="grid gap-1 pl-6 font-mono text-xs break-all text-ink-2">
          {step.sent && <p>发出：{step.sent}</p>}
          {step.got && <p>收到：{step.got}</p>}
          {step.note && <p className="font-sans text-warning">{step.note}</p>}
        </div>
      )}
    </li>
  );
}
