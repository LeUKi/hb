import {
  JUDGE_NAME_LIMITS,
  JUDGE_OLDEST_PROTOCOL,
  type JudgeDeclarations,
  type JudgeVersions,
  judgeDescriptionSchema,
  judgeNameSchema,
  type MyJudgeDetail,
  type MyJudgeVersion,
  normalizePageUrl,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { paramValues } from "../../../../../kit/runtime/params.mjs";
import { ActivityRequestError, refused } from "../../lib/activities";
import { cn } from "../../lib/cn";
import {
  useJudgePage,
  useMyJudge,
  useMyJudgeVersion,
  useSetJudgeListing,
  useUpdateMyJudge,
} from "../../lib/judge";
import { type SessionUser, useIdentity } from "../../lib/session";
import { JudgeWriter } from "../hongbao-form/code-step";
import { counter, type Update } from "../hongbao-form/fields";
import {
  emptyForm,
  type FormState,
  issuesOf,
} from "../hongbao-form/form-state";
import { ParamsFields, paramsFor } from "../hongbao-form/params-fields";
import { TryJudge } from "../hongbao-form/try-judge";
import { useJudgeDeploy } from "../hongbao-form/use-judge-deploy";
import { dayLabel, JudgeHelpLinks, statsLine } from "../judges/judge-bits";
import { Callout, Page, PageHeader, PageSection, Panel } from "../page/page";
import { Bone, PageLoad, queryLoad } from "../page/page-state";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { LeaveGuard } from "../shell/leave-guard";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { CodeEditor } from "../ui/code-editor";
import { CopyButton } from "../ui/copy-button";
import { Field, Segmented, Switch, TextInput } from "../ui/field";
import { Reveal, Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { PublicJudgePage, RulesList, ruleLines } from "./judge-public-view";
import { MessageView } from "./message-view";

// 判定器页 /judges/<编号> (docs/judge-square-design.md §8, §14.4, §15.4):
// one's own — its name and line, 代码公开, 判定器广场, every version, and
// 部署新版本 with the 发红包 form's own card; 用它发红包 at the top — or,
// for anyone else it is open to, what the 广场 shows of it.

/** "10月28日 20:00", a version's deploy. */
function deployedLabel(at: number) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${dayLabel(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A failed write, said as the form says its own. */
const failedSave = (failure: unknown) =>
  refused(failure)
    ? failure.message
    : "保存没有完成：网络或服务出了问题。可以再试一次。";

/** Its name and line, and 代码公开 (§2): only ever to 一直公开. */
function Settings({
  judge,
  userId,
  onChanged,
}: {
  judge: MyJudgeDetail;
  userId: string;
  onChanged: (changed: boolean) => void;
}) {
  const [name, setName] = useState(judge.name);
  const [description, setDescription] = useState(judge.description);
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [publicError, setPublicError] = useState<string | null>(null);
  const write = useUpdateMyJudge(userId, judge.id);
  const nameRead = judgeNameSchema.safeParse(name);
  const descriptionRead = judgeDescriptionSchema.safeParse(description);
  // An empty name says so once 保存 was pressed; one too long at once.
  const nameError =
    !nameRead.success && (tried || name.trim() !== "")
      ? nameRead.error.issues[0]?.message
      : undefined;
  const descriptionError = descriptionRead.success
    ? undefined
    : descriptionRead.error.issues[0]?.message;
  const changed =
    name.trim() !== judge.name || description.trim() !== judge.description;
  useEffect(() => onChanged(changed), [changed, onChanged]);
  const save = () => {
    if (write.isPending || !changed) return;
    setTried(true);
    if (!nameRead.success || !descriptionRead.success) return;
    setError(null);
    write.mutate(
      {
        name: nameRead.data,
        description: descriptionRead.data,
        codePublic: judge.codePublic,
      },
      {
        onSuccess: () => setSaved(true),
        onError: (failure) => setError(failedSave(failure)),
      },
    );
  };
  const always = judge.codePublic === "always";
  return (
    <Panel className="grid gap-4 p-4">
      <div className="@container/naming">
        <div className="grid gap-4 @min-[30rem]/naming:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Field
            label="名字"
            htmlFor="judge-name"
            error={nameError}
            aside={counter(name, JUDGE_NAME_LIMITS.name)}
          >
            <TextInput
              id="judge-name"
              value={name}
              invalid={Boolean(nameError)}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") save();
              }}
            />
          </Field>
          <Field
            label="一句说明（选填）"
            htmlFor="judge-description"
            error={descriptionError}
            aside={counter(description, JUDGE_NAME_LIMITS.description)}
          >
            <TextInput
              id="judge-description"
              value={description}
              invalid={Boolean(descriptionError)}
              autoComplete="off"
              onChange={(event) => {
                setDescription(event.target.value);
                setSaved(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") save();
              }}
            />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          size="sm"
          aria-disabled={write.isPending || !changed || undefined}
          onClick={save}
        >
          {write.isPending && !confirm ? "正在保存…" : "保存"}
        </Button>
        <p role="status" className="text-sm text-success">
          {saved && !changed ? "已保存" : ""}
        </p>
      </div>
      <Reveal show={Boolean(error)}>
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      </Reveal>
      <div className="grid gap-1.5 border-line border-t pt-4">
        <span className="text-sm font-medium text-ink">代码公开</span>
        <div>
          <Segmented
            label="代码公开"
            value={judge.codePublic}
            disabled={always}
            options={[
              { value: "ended", label: "结束后公开" },
              { value: "always", label: "一直公开" },
            ]}
            onChange={(value) => {
              if (value === "always") {
                setPublicError(null);
                setConfirm(true);
              }
            }}
          />
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        busy={write.isPending}
        title="改成一直公开？"
        text="所有人都能看到这个判定器的代码。改了就改不回来。"
        error={publicError}
        actions={
          <>
            <Button
              onClick={() => setConfirm(false)}
              aria-disabled={write.isPending || undefined}
            >
              返回
            </Button>
            <Button
              variant="primary"
              aria-disabled={write.isPending || undefined}
              onClick={() => {
                if (write.isPending) return;
                write.mutate(
                  {
                    name: judge.name,
                    description: judge.description,
                    codePublic: "always",
                  },
                  {
                    onSuccess: () => setConfirm(false),
                    onError: (failure) => setPublicError(failedSave(failure)),
                  },
                );
              }}
            >
              {write.isPending ? "正在保存…" : "一直公开"}
            </Button>
          </>
        }
      />
    </Panel>
  );
}

/**
 * 判定器广场 (§8, §15.4): joining it (its code public for good) and
 * leaving, each asked first; 允许站长选入精选; where it stands. Taken down,
 * the 站长's reason instead.
 */
function SquareSettings({
  judge,
  userId,
}: {
  judge: MyJudgeDetail;
  userId: string;
}) {
  const write = useSetJudgeListing(userId, judge.id);
  const [asking, setAsking] = useState<"join" | "leave" | null>(null);
  const [featurable, setFeaturable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const hint = "站长可以原样选入，或者改进后选入，署名保留。";
  const answer = (listed: boolean, allow: boolean) => {
    if (write.isPending) return;
    setAskError(null);
    write.mutate(
      { listed, featurable: allow },
      {
        onSuccess: () => setAsking(null),
        onError: (failure) => setAskError(failedSave(failure)),
      },
    );
  };
  return (
    <Panel className="grid gap-4 p-4">
      {judge.takenDown && (
        <Callout tone="danger" icon={AlertTriangle} title="已被站长撤下">
          <span className="block">原因：{judge.takenDown.reason}</span>
          <span className="block">
            新的红包选不到它，已经选进草稿的也不能开放；已经开放的照常。
          </span>
        </Callout>
      )}
      <Switch
        checked={judge.listed}
        disabled={Boolean(judge.takenDown)}
        label="加入判定器广场"
        description="加入后别人能看代码、用它发红包。"
        onChange={(on) => {
          setAskError(null);
          setFeaturable(true);
          setAsking(on ? "join" : "leave");
        }}
      />
      <Reveal show={judge.listed}>
        <div className="flex min-w-0 flex-col gap-4">
          <Switch
            // Turned at once; back if the save fails.
            checked={
              write.isPending
                ? (write.variables?.featurable ?? judge.featurable)
                : judge.featurable
            }
            label="允许站长选入精选"
            description={
              judge.featured === null
                ? hint
                : `${hint}取消只影响以后，已经选入的留着。`
            }
            onChange={(allow) => {
              if (write.isPending) return;
              setError(null);
              write.mutate(
                { listed: true, featurable: allow },
                { onError: (failure) => setError(failedSave(failure)) },
              );
            }}
          />
          <p className="text-sm text-ink-2">
            {judge.featured !== null
              ? `站长精选了第 ${judge.featured} 版。`
              : judge.publicN !== null
                ? `广场上用的是第 ${judge.publicN} 版。`
                : "还没有开放过红包的版本，广场上暂时看不到它。"}
          </p>
        </div>
      </Reveal>
      <Reveal show={Boolean(error)}>
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      </Reveal>
      <ConfirmDialog
        open={asking === "join"}
        onClose={() => setAsking(null)}
        busy={write.isPending}
        title="加入判定器广场？"
        text={
          judge.codePublic === "always"
            ? "别人能看代码、用它发红包。"
            : "代码会一直公开，改不回来；别人能看代码、用它发红包。"
        }
        error={askError}
        actions={
          <>
            <Button
              onClick={() => setAsking(null)}
              aria-disabled={write.isPending || undefined}
            >
              返回
            </Button>
            <Button
              variant="primary"
              aria-disabled={write.isPending || undefined}
              onClick={() => answer(true, featurable)}
            >
              {write.isPending ? "正在保存…" : "加入"}
            </Button>
          </>
        }
      >
        <Switch
          checked={featurable}
          label="允许站长选入精选"
          description={hint}
          onChange={setFeaturable}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === "leave"}
        onClose={() => setAsking(null)}
        busy={write.isPending}
        title="退出判定器广场？"
        text="新的红包不能再选它；已经开放的照旧，已经选进草稿的照样能开放。代码照旧一直公开。"
        error={askError}
        actions={
          <>
            <Button
              onClick={() => setAsking(null)}
              aria-disabled={write.isPending || undefined}
            >
              返回
            </Button>
            <Button
              variant="primary"
              aria-disabled={write.isPending || undefined}
              onClick={() => answer(false, judge.featurable)}
            >
              {write.isPending ? "正在保存…" : "退出"}
            </Button>
          </>
        }
      />
    </Panel>
  );
}

/**
 * 参数和试一试 (§16.2): the newest version that passed — the one 用它发红包
 * takes — as a sender gets it: its params with their defaults, to change
 * and try; what it sets on 发多少; 试一试 on a 红包 of its defaults. A new
 * one that passes takes its place, from its own defaults.
 */
function TryVersion({ judge }: { judge: MyJudgeDetail }) {
  const usable = judge.usable;
  return (
    <PageSection
      title="参数和试一试"
      description={
        usable ? `第 ${usable.n} 版测试全过，用它发红包时是这样。` : undefined
      }
    >
      <Swap id={usable ? `n${usable.n}` : "none"}>
        {usable ? (
          <Trying
            judgeId={judge.id}
            n={usable.n}
            declarations={usable.declarations}
          />
        ) : (
          <Panel className="px-4 py-3 text-sm text-ink-2">
            还没有测试全过的版本。部署一版测试全过的，就能在这里看参数、试一试。
          </Panel>
        )}
      </Swap>
    </PageSection>
  );
}

function Trying({
  judgeId,
  n,
  declarations,
}: {
  judgeId: string;
  n: number;
  declarations: JudgeDeclarations | null;
}) {
  const params = declarations?.params ?? [];
  const [values, setValues] = useState(() => paramsFor(params, {}));
  // A param's problem shows once it was changed: one with no default is
  // not wrong before anyone touched it.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const read = paramValues(params, values);
  const errorOf = (key: string) =>
    touched.has(key) && "problems" in read
      ? read.problems.find((problem) => (problem.key || params[0]?.key) === key)
          ?.message
      : undefined;
  const hongbao = declarations?.hongbao;
  const rules = ruleLines(hongbao);
  const page = normalizePageUrl(declarations?.meta?.page ?? "");
  // A 红包 of its defaults; without one, the least it allows.
  const count = hongbao?.count?.default ?? hongbao?.count?.min ?? 1;
  const minEach = hongbao?.minEach?.default ?? hongbao?.minEach?.min ?? 1;
  const tried = {
    title: hongbao?.title ?? "试一试",
    count,
    minEach,
    total:
      hongbao?.total?.default ??
      Math.max(hongbao?.total?.min ?? 0, count * minEach, count * 100),
  };
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-2">
        <p className="px-1 text-xs text-ink-3">参数</p>
        <Panel className="p-4">
          {params.length === 0 ? (
            <p className="text-sm text-ink-2">没有参数，挑了就能发。</p>
          ) : (
            <ParamsFields
              params={params}
              values={values}
              errorOf={errorOf}
              locked={false}
              idPrefix="hb-try-param-"
              onChange={(key, value) => {
                setValues((current) => ({ ...current, [key]: value }));
                setTouched((current) => new Set(current).add(key));
              }}
            />
          )}
        </Panel>
      </div>
      {(rules.length > 0 || hongbao?.note || page) && (
        <div className="grid gap-2">
          <p className="px-1 text-xs text-ink-3">发多少</p>
          {(rules.length > 0 || hongbao?.note) && (
            <RulesList rules={rules} note={hongbao?.note} />
          )}
          {/* 判定器带的附带网页 (judge-page §11.3), in a new tab. */}
          {page && (
            <p className="px-1 text-sm text-ink-2">
              附带网页：
              <a
                href={page}
                target="_blank"
                rel="noreferrer"
                className="text-accent-ink underline-offset-2 hover:underline"
              >
                {new URL(page).hostname} ↗
              </a>
            </p>
          )}
        </div>
      )}
      <TryJudge
        judgeId={judgeId}
        n={n}
        params={values}
        hongbao={tried}
        prompt=""
        disabled={false}
      />
    </div>
  );
}

/** A version's row: when, whether its tests passed, 红包 it opened; its code. */
function VersionRow({
  judgeId,
  userId,
  version,
}: {
  judgeId: string;
  userId: string;
  version: MyJudgeVersion;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const head = useId();
  const detail = useMyJudgeVersion(userId, judgeId, open ? version.n : null);
  return (
    <li className="flex flex-col">
      <Squircle radius={radius.row}>
        <button
          id={head}
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-base font-medium text-ink">
              第 {version.n} 版 ·{" "}
              {deployedLabel(Date.parse(version.deployedAt))} 部署
            </span>
            <span className="text-sm">
              <span className={version.passed ? "text-success" : "text-danger"}>
                {version.passed ? "测试全过" : "测试没过"}
              </span>
              {/* A 旧判定器 (multi-prize §3.6): passed on the old rules. */}
              {version.passed && version.protocol < JUDGE_OLDEST_PROTOCOL && (
                <span className="text-ink-3">
                  {" "}
                  · 旧判定器，要按新规则重新跑测试
                </span>
              )}
              {version.opened > 0 && (
                <span className="text-ink-3">
                  {" "}
                  · 开放过 {version.opened} 个红包
                </span>
              )}
            </span>
          </span>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-ink-3 transition-transform",
              open && "rotate-90",
            )}
            aria-hidden="true"
          />
        </button>
      </Squircle>
      <Reveal show={open}>
        <div id={panel} className="grid gap-3 px-3 pt-1 pb-3">
          <div className="grid gap-1">
            <span className="text-xs text-ink-3">代码指纹</span>
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-mono text-sm break-all text-ink">
                {version.fingerprint}
              </span>
              <CopyButton value={version.fingerprint} label="代码指纹" />
            </span>
          </div>
          {version.network && (
            <p className="text-sm text-ink">
              联网：
              <span className="font-mono break-all">
                {version.network.join("、")}
              </span>
            </p>
          )}
          <Swap
            id={detail.data ? "code" : detail.isError ? "failed" : "loading"}
          >
            {detail.data ? (
              <CodeEditor
                value={detail.data.code}
                language="js"
                readOnly
                labelledBy={head}
                rows={4}
                maxRows={22}
              />
            ) : detail.isError ? (
              <p className="flex items-center gap-3 text-sm text-danger">
                读取失败
                <Button size="xs" onClick={() => void detail.refetch()}>
                  重试
                </Button>
              </p>
            ) : (
              open && (
                <div className="grid gap-2">
                  <p role="status" className="sr-only">
                    正在读取…
                  </p>
                  <Bone className="h-3 w-full" />
                  <Bone className="h-3 w-5/6" />
                  <Bone className="h-3 w-2/3" />
                </div>
              )
            )}
          </Swap>
        </div>
      </Reveal>
    </li>
  );
}

/**
 * 部署新版本 (§8): the 发红包 form's own card, its code and tests those
 * of the newest version as it was last run.
 */
function DeployForm({
  judge,
  userId,
  seed,
  onChanged,
}: {
  judge: MyJudgeDetail;
  userId: string;
  seed: { code: string; tests: string; versions: JudgeVersions };
  onChanged: (changed: boolean) => void;
}) {
  const [start] = useState<FormState>(() => {
    const base = emptyForm();
    return {
      ...base,
      mode: "code",
      judge: {
        ...base.judge,
        judgeId: judge.id,
        name: judge.name,
        description: judge.description,
        code: seed.code,
        tests: seed.tests,
        versions: seed.versions,
      },
    };
  });
  const [form, setForm] = useState(start);
  const update: Update = (change) => setForm(change);
  const [said, setSaid] = useState("");
  const deploy = useJudgeDeploy({ form, userId, update, say: setSaid });
  // Its card says the name as it is now.
  useEffect(() => {
    setForm((current) => ({
      ...current,
      judge: { ...current.judge, name: judge.name },
    }));
  }, [judge.name]);
  const issues = issuesOf(form);
  const errorOf = (field: string) =>
    field === "hb-code-code" || field === "hb-code-tests"
      ? issues.find((issue) => issue.field === field)?.message
      : undefined;
  // Changed here and not deployed, or not run, as it stands.
  const changed =
    (form.judge.code !== start.judge.code ||
      form.judge.tests !== start.judge.tests) &&
    (deploy.status === "new" || deploy.rerun);
  useEffect(() => onChanged(changed), [changed, onChanged]);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <JudgeWriter
        form={form}
        update={update}
        errorOf={errorOf}
        locked={false}
        frozen={false}
        judge={deploy}
        gated={false}
      />
      <p role="status" className="sr-only">
        {said}
      </p>
    </div>
  );
}

function DeployNew({
  judge,
  userId,
  onChanged,
}: {
  judge: MyJudgeDetail;
  userId: string;
  onChanged: (changed: boolean) => void;
}) {
  // The newest version as the page opened: a deploy here adds the next.
  const [from] = useState(judge.latest?.n ?? null);
  const seed = useMyJudgeVersion(userId, judge.id, from);
  return (
    <Swap id={seed.data ? "form" : seed.isError ? "failed" : "loading"}>
      <DeployState
        judge={judge}
        userId={userId}
        seed={seed}
        onChanged={onChanged}
      />
    </Swap>
  );
}

/** 部署新版本 as its seed reads: the form, a failed read, or bones. */
function DeployState({
  judge,
  userId,
  seed,
  onChanged,
}: {
  judge: MyJudgeDetail;
  userId: string;
  seed: ReturnType<typeof useMyJudgeVersion>;
  onChanged: (changed: boolean) => void;
}) {
  if (seed.data)
    return (
      <DeployForm
        judge={judge}
        userId={userId}
        seed={seed.data}
        onChanged={onChanged}
      />
    );
  if (seed.isError)
    return (
      <p className="flex items-center gap-3 text-sm text-danger">
        读取失败
        <Button size="xs" onClick={() => void seed.refetch()}>
          重试
        </Button>
      </p>
    );
  return (
    <Panel className="grid gap-3 p-4">
      <p role="status" className="sr-only">
        正在读取…
      </p>
      <Bone className="h-4 w-28" radius={5} />
      <Bone className="h-3 w-full" />
      <Bone className="h-3 w-5/6" />
    </Panel>
  );
}

function JudgePage({
  judge,
  user,
}: {
  judge: MyJudgeDetail;
  user: SessionUser;
}) {
  const navigate = useNavigate();
  const [changed, setChanged] = useState({ settings: false, deploy: false });
  // Its numbers as the 广场 says them (§15.4).
  const line = [
    judge.latest && `第 ${judge.latest.n} 版`,
    statsLine(judge.stats),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Page>
      <PageHeader
        eyebrow="我的判定器"
        title={judge.name}
        description={
          <>
            {judge.description && (
              <span className="block">{judge.description}</span>
            )}
            <span className="block text-ink-3">{line}</span>
          </>
        }
        actions={
          judge.usable && (
            <ButtonLink
              variant="primary"
              href={`/new?judge=${encodeURIComponent(judge.id)}`}
              onGo={() =>
                void navigate({ to: "/new", search: { judge: judge.id } })
              }
            >
              用它发红包
            </ButtonLink>
          )
        }
        refreshable
      />
      <PageSection title="设置">
        <Settings
          judge={judge}
          userId={user.id}
          onChanged={(settings) =>
            setChanged((current) =>
              current.settings === settings
                ? current
                : { ...current, settings },
            )
          }
        />
      </PageSection>
      <PageSection title="判定器广场">
        <SquareSettings judge={judge} userId={user.id} />
      </PageSection>
      <TryVersion judge={judge} />
      <PageSection title="版本">
        <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
          {judge.versions.map((version) => (
            <VersionRow
              key={version.n}
              judgeId={judge.id}
              userId={user.id}
              version={version}
            />
          ))}
        </Panel>
      </PageSection>
      <PageSection title="部署新版本" action={<JudgeHelpLinks />}>
        <DeployNew
          judge={judge}
          userId={user.id}
          onChanged={(deploy) =>
            setChanged((current) =>
              current.deploy === deploy ? current : { ...current, deploy },
            )
          }
        />
      </PageSection>
      <LeaveGuard
        when={changed.settings || changed.deploy}
        message="改过的内容还没保存，离开后会丢失。"
      />
    </Page>
  );
}

/** One's own, read as its author reads it. */
function OwnJudge({ id, user }: { id: string; user: SessionUser }) {
  const query = useMyJudge(user.id, id);
  return (
    <PageLoad load={queryLoad(query)}>
      {query.data && <JudgePage judge={query.data} user={user} />}
    </PageLoad>
  );
}

export function JudgeView({ id }: { id: string }) {
  const { user, ready } = useIdentity();
  const viewerId = user?.id ?? null;
  // Whoever looks: its author gets their own page.
  const query = useJudgePage(viewerId, id, ready);
  const error = query.error;
  if (error instanceof ActivityRequestError && error.status === 404)
    return (
      <MessageView
        title="未找到判定器"
        text="判定器不存在，或者不在判定器广场里。"
      />
    );
  if (query.data?.own && user) return <OwnJudge id={id} user={user} />;
  return (
    <PageLoad load={queryLoad(query)}>
      {query.data && <PublicJudgePage judge={query.data} viewerId={viewerId} />}
    </PageLoad>
  );
}
