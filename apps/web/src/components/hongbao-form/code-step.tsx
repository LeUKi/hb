import { JUDGE_LIMITS, type JudgeCheck } from "@hb/contracts";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  Check,
  ClipboardPaste,
  FileUp,
  FolderGit2,
  Info,
  X,
} from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { cn } from "../../lib/cn";
import { KIT_URL } from "../../lib/judge";
import { Callout } from "../page/page";
import { Button } from "../ui/button";
import { CodeEditor } from "../ui/code-editor";
import { Field, TextInput } from "../ui/field";
import { Reveal } from "../ui/reveal";
import { counter, type ErrorOf, QuietLine, type Update } from "./fields";
import type { FormState } from "./form-state";
import { FilePicker, fromClipboard, JudgeCard } from "./judge-card";
import { testCount } from "./steps";
import type { JudgeDeploy } from "./use-judge-deploy";

/**
 * tests.json: still a plain box (07 §5) with line numbers and colours (05
 * §14) to type or paste into, its name and count above.
 */
function TestsBox({
  value,
  error,
  disabled,
  frozen,
  onChange,
}: {
  value: string;
  error?: string;
  disabled: boolean;
  /**
   * Saving, or waiting on 重试原提交: the step's fieldset stops native
   * controls only, so the editor is told too.
   */
  frozen: boolean;
  onChange: (value: string) => void;
}) {
  const id = "hb-code-tests";
  const file = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const labelId = useId();
  const paste = async () => {
    // No clipboard permission: the box takes ⌘V as ever.
    if (!(await fromClipboard(onChange))) document.getElementById(id)?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {/* The editor is no form control: its name goes by aria-labelledby. */}
        <span id={labelId} className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-medium text-ink">
            tests.json
          </span>
          <span className="text-xs text-ink-3">{testCount(value)}</span>
        </span>
        {!disabled && (
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => void paste()}>
              <ClipboardPaste />
              粘贴
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => file.current?.click()}
            >
              <FileUp />
              从文件选
            </Button>
            <FilePicker
              pickerRef={file}
              accept=".json,application/json"
              onText={onChange}
            />
          </span>
        )}
      </div>
      <p id={noteId} className="text-xs text-ink-3">
        只是数据，不算进代码，不公开。
      </p>
      <CodeEditor
        id={id}
        labelledBy={labelId}
        describedBy={[noteId, error ? `${id}-error` : ""].join(" ").trim()}
        value={value}
        onChange={onChange}
        language="json"
        placeholder={
          '{\n  "tests": [\n    { "name": "答对", "input": "flag{…}", "expect": { "ok": true } }\n  ]\n}'
        }
        disabled={disabled || frozen}
        invalid={Boolean(error)}
        rows={6}
        maxRows={16}
      />
      <Reveal show={Boolean(error)}>
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      </Reveal>
    </div>
  );
}

function Row({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? (
        <Check
          className="mt-0.5 size-4 shrink-0 text-success"
          aria-label="通过"
        />
      ) : (
        <X className="mt-0.5 size-4 shrink-0 text-danger" aria-label="没过" />
      )}
      <span className={cn("min-w-0", ok ? "text-ink-2" : "text-danger")}>
        {children}
      </span>
    </li>
  );
}

/** A deploy's (or rerun's) result, row by row (07 §5). */
function CheckResult({ check }: { check: JudgeCheck }) {
  const loaded = check.problems.length === 0 && !check.loadProblem;
  const passedTests = check.tests.filter((test) => test.passed).length;
  return (
    <ul className="grid gap-1.5" aria-label="测试结果">
      <Row ok={check.problems.length === 0}>
        import 都在清单里
        {check.problems.map((problem) => (
          <span
            key={`${problem.line}:${problem.message}`}
            className="block text-xs"
          >
            第 {problem.line} 行：{problem.message}
          </span>
        ))}
      </Row>
      {check.problems.length === 0 && (
        <Row ok={loaded}>
          代码能加载、导出了 judge
          {check.loadProblem && (
            <span className="block text-xs break-all">{check.loadProblem}</span>
          )}
        </Row>
      )}
      {check.testsProblem ? (
        <Row ok={false}>{check.testsProblem}</Row>
      ) : (
        loaded && (
          <Row ok={passedTests === check.tests.length}>
            测试 {passedTests} / {check.tests.length} 通过
            {check.slowestMs !== null && ` · 最慢 ${check.slowestMs} 毫秒`}
            {check.tests
              .filter((test) => !test.passed)
              .slice(0, 5)
              .map((test) => (
                <span key={test.name} className="block text-xs break-all">
                  {test.name}：{test.problem}
                </span>
              ))}
          </Row>
        )
      )}
      {check.networkProblems && (
        <Row ok={false}>
          联网
          {check.networkProblems.map((problem) => (
            <span key={problem} className="block text-xs break-all">
              {problem}
            </span>
          ))}
        </Row>
      )}
      {check.unstable.length > 0 && (
        <li className="pl-6 text-xs text-warning">
          两次跑出的结果不一样：{check.unstable.join("、")}
          。用了真随机，重放会对不上。
        </li>
      )}
    </ul>
  );
}

/**
 * 联网 (docs/programmable-hongbao-design.md §9.5): the addresses the code
 * may ask, read from it by its deploy, and what that means for whom.
 */
function NetworkNote({ network }: { network: string[] }) {
  return (
    <div className="grid gap-1.5 rounded-xl bg-fill px-3.5 py-3">
      <p className="text-sm text-ink">
        联网：
        {network.map((address, index) => (
          <span key={address}>
            {index > 0 && "、"}
            <span className="font-mono break-all">{address}</span>
          </span>
        ))}
      </p>
      <ul className="grid gap-1 text-xs text-ink-2">
        <li>领的人提交的内容可能被发到这些地址。</li>
        <li>结束后代码公开，写在代码里的令牌也会公开，结束后请作废。</li>
        <li>
          红包结束后，领的人能看到自己那几次判定的返回内容，别在返回里放不想公开的东西。
        </li>
      </ul>
    </div>
  );
}

/** “今天还能部署 7 次”, or that today's are used up (07 §5). */
function quotaText(judge: JudgeDeploy) {
  if (judge.deploysLeft === undefined) return null;
  return judge.deploysLeft > 0 ? (
    <>
      今天还能部署{" "}
      <b className="font-semibold text-ink tabular-nums">{judge.deploysLeft}</b>{" "}
      次
    </>
  ) : (
    `今天的 ${judge.deployLimit ?? ""} 次部署用完了，明天再来`
  );
}

/**
 * 部署 (07 §5): a new version's 部署并跑测试 with today's count, or for a
 * version whose tests changed 重新跑测试 (no deploy, nothing counted); the
 * last run's rows; and why 保存并开放 waits, once it was pressed.
 */
function DeployArea({
  judge,
  frozen,
  gated,
}: {
  judge: JudgeDeploy;
  frozen: boolean;
  gated: boolean;
}) {
  const check = judge.result?.check;
  const used = judge.deploysLeft === 0;
  // A version whose run failed takes no second deploy: a new one does.
  const failed = Boolean(judge.version) && judge.result?.passed === false;
  // Its rows went with the page that ran it (a draft opened again): a
  // rerun, free, brings them back.
  const unseen = failed && !check;
  const fresh = !judge.version && judge.status !== "empty";
  // Grey but focusable while it runs (07 §1): it was just pressed.
  const held = !fresh || used || judge.busy || frozen || !judge.known;
  return (
    <fieldset
      id="hb-code-check"
      aria-label="部署"
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-3 outline-none"
    >
      <Reveal show={Boolean(check)}>
        {check && <CheckResult check={check} />}
      </Reveal>
      <Reveal show={Boolean(judge.network)}>
        {judge.network && <NetworkNote network={judge.network} />}
      </Reveal>
      {judge.rerun && judge.version ? (
        <Callout icon={Info} className="items-center [&>div:last-child]:flex-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="min-w-0 flex-1">
              {judge.upgraded
                ? `判定器升级到第三版了：在判定器 第 ${judge.version.n} 版 上重新跑一遍测试才能开放。不算部署，不扣次数。`
                : `tests.json 改过了：在判定器 第 ${judge.version.n} 版 上重新跑一遍才能开放。不算部署，不扣次数。`}
            </span>
            <Button
              size="xs"
              aria-disabled={judge.busy || frozen || undefined}
              data-disabled={judge.busy || frozen || undefined}
              onClick={() => {
                if (!judge.busy && !frozen) void judge.deploy();
              }}
            >
              {judge.pending === "rerun" ? "正在跑测试…" : "重新跑测试"}
            </Button>
          </span>
        </Callout>
      ) : (
        // A version deployed shows a button only when its run failed.
        (!judge.version || failed) && (
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                variant="lacquer"
                size="sm"
                aria-disabled={held || undefined}
                data-disabled={held || undefined}
                onClick={() => {
                  if (!held) void judge.deploy();
                }}
              >
                {judge.pending === "deploy" ? "正在部署…" : "部署并跑测试"}
              </Button>
              {unseen && (
                <Button
                  size="xs"
                  aria-disabled={judge.busy || frozen || undefined}
                  data-disabled={judge.busy || frozen || undefined}
                  onClick={() => {
                    if (!judge.busy && !frozen) void judge.deploy();
                  }}
                >
                  {judge.pending === "rerun" ? "正在跑测试…" : "重新跑测试"}
                </Button>
              )}
              <span className="min-w-0 flex-1 text-xs text-ink-2">
                {failed && "改出新版本才能再部署"}
                {failed && quotaText(judge) && " · "}
                {quotaText(judge)}
              </span>
            </div>
            {unseen && (
              <p className="text-xs text-ink-3">
                没过的是哪几条没留下：重新跑测试就能看到，不算部署。
              </p>
            )}
            {/* Stopped by 保存并开放, the red line below says why instead. */}
            {fresh && !(gated && judge.gate) && (
              <p className="text-xs text-ink-3">
                {used
                  ? "已经部署过的判定器换回去照样能开放。"
                  : "部署：把这一版代码做成判定器，在线上跑你的测试。开放前谁也领不到；只改测试再跑，不算部署。"}
              </p>
            )}
          </div>
        )
      )}
      {/* Read out by the form's alert region, as it happens. */}
      <Reveal show={Boolean(judge.error)}>
        <p className="text-sm text-danger">{judge.error}</p>
      </Reveal>
      <Reveal show={gated && Boolean(judge.gate)}>
        <p className="text-sm text-danger">{judge.gate}</p>
      </Reveal>
    </fieldset>
  );
}

/**
 * ③ 代码 (代码判定红包, in place of 怎么领): the prompt shown to claimants,
 * judge.js as a 判定器 card, tests.json as typed, and 部署 into the sandbox
 * the claims will use (docs/programmable-hongbao-design.md §5).
 */
export function CodeStep({
  form,
  update,
  errorOf,
  locked,
  frozen,
  judge,
  gated,
  openSheet,
  deadline,
  timingError,
  scopeError,
  timeLine,
  scopeLine,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  locked: boolean;
  /** Saving, or waiting on 重试原提交 (the form's fieldset lock). */
  frozen: boolean;
  judge: JudgeDeploy;
  /** 保存并开放 was stopped by it: said in red in the deploy area. */
  gated: boolean;
  openSheet: (group: "timing" | "scope") => void;
  deadline?: string;
  timingError?: string;
  scopeError?: string;
  timeLine: string;
  scopeLine: string;
}) {
  const set = (key: "prompt" | "tests") => (value: string) =>
    update((current) => ({
      ...current,
      judge: { ...current.judge, [key]: value },
    }));
  const check = judge.result?.check;
  const problemLines =
    check?.fingerprint === judge.fingerprint
      ? (check?.problems.map((problem) => problem.line) ?? [])
      : [];
  const named = judge.version ? `判定器 第 ${judge.version.n} 版 ` : "判定器";
  return (
    // A grid of one shrinkable column: the long lines of the code and the
    // tests stay in their editors and never widen the step. Its children
    // are no Reveals; the columns inside that hold one are flex.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <Field
        label="领取时的提示"
        htmlFor="hb-code-prompt"
        hint="显示在领取的人的输入框上方。"
        error={errorOf("hb-code-prompt")}
        aside={counter(form.judge.prompt, JUDGE_LIMITS.promptCharacters)}
      >
        <TextInput
          id="hb-code-prompt"
          value={form.judge.prompt}
          placeholder="例如：输入你解出的 flag"
          disabled={locked}
          invalid={Boolean(errorOf("hb-code-prompt"))}
          autoComplete="off"
          onChange={(event) => set("prompt")(event.target.value)}
        />
      </Field>
      <div className="flex flex-col gap-2.5">
        {/* 换回 (§5): the latest passing version, put back with no deploy. */}
        <Reveal show={!locked && Boolean(judge.restore)}>
          {judge.restore && (
            <Callout
              tone="warning"
              icon={AlertTriangle}
              className="items-center [&>div:last-child]:flex-1"
            >
              <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {/* A version deployed already takes no second deploy:
                    the deploy area says what it waits for. */}
                <span className="min-w-0 flex-1">
                  {judge.version ? (
                    <>
                      代码换了：判定器 第 {judge.version.n}{" "}
                      版还没有测试全过，可以换回测试全过的第 {judge.restore.n}{" "}
                      版。
                    </>
                  ) : (
                    <>
                      代码换了：和测试全过的判定器 第 {judge.restore.n}{" "}
                      版不一样，要部署这一版才能开放；或者换回去。
                    </>
                  )}
                </span>
                <Button
                  size="xs"
                  aria-disabled={judge.busy || frozen || undefined}
                  data-disabled={judge.busy || frozen || undefined}
                  onClick={() => {
                    if (!judge.busy && !frozen) judge.restoreCode();
                  }}
                >
                  换回第 {judge.restore.n} 版
                </Button>
              </span>
            </Callout>
          )}
        </Reveal>
        <JudgeCard
          code={form.judge.code}
          judge={judge}
          locked={locked}
          busy={frozen || judge.busy}
          problemLines={problemLines}
          error={errorOf("hb-code-code")}
        />
      </div>
      <TestsBox
        value={form.judge.tests}
        error={errorOf("hb-code-tests")}
        disabled={locked}
        frozen={frozen}
        onChange={set("tests")}
      />
      {!locked && <DeployArea judge={judge} frozen={frozen} gated={gated} />}
      {/* In a new tab: the form stays as it is. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {[
          { href: "/help/code", icon: BookOpen, label: "开发文档" },
          { href: "/help/code#ai", icon: Bot, label: "给 AI 的说明" },
          { href: KIT_URL, icon: FolderGit2, label: "本地开发包" },
        ].map((entry) => (
          <a
            key={entry.href}
            href={entry.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-accent-ink hover:underline"
          >
            <entry.icon className="size-4" aria-hidden="true" />
            {entry.label} ↗
          </a>
        ))}
      </div>
      {locked ? (
        <>
          <p className="px-1 text-sm text-ink-2">{deadline ?? timeLine}</p>
          <p className="px-1 text-sm text-ink-2">{scopeLine}</p>
        </>
      ) : (
        <>
          <QuietLine
            id="hb-quiet-timing"
            text={deadline ?? timeLine}
            error={timingError}
            onOpen={() => openSheet("timing")}
          />
          <QuietLine
            id="hb-quiet-scope"
            text={scopeLine}
            error={scopeError}
            onOpen={() => openSheet("scope")}
          />
        </>
      )}
      <p className="text-xs text-ink-3">
        {locked ? "由" : "开放后由"}
        {named}判定每次提交，不能再换；结束后所有人都能看到代码。
      </p>
    </div>
  );
}
