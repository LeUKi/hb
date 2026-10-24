import { JUDGE_LIMITS, type JudgeCheck } from "@hb/contracts";
import {
  BookOpen,
  Bot,
  Check,
  ClipboardPaste,
  FileUp,
  FolderGit2,
  X,
} from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import { KIT_URL } from "../../lib/judge";
import { Button } from "../ui/button";
import { Field, TextInput } from "../ui/field";
import { Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { counter, type ErrorOf, QuietLine, type Update } from "./fields";
import type { FormState } from "./form-state";
import { sizeOf, testCount } from "./steps";

/** Where 在线检查 stands for the code and tests as they are typed. */
export type CodeCheckState =
  /** Passed for exactly these. */
  | { kind: "passed"; check?: JudgeCheck }
  /** Ran on these and did not pass. */
  | { kind: "failed"; check: JudgeCheck }
  /** Not run on these (never, or they changed since). */
  | { kind: "unchecked"; changed: boolean };

/** judge.js or tests.json: a dark box to paste into, its name and size above. */
function CodeBox({
  id,
  name,
  meta,
  note,
  value,
  placeholder,
  rows,
  error,
  disabled,
  accept,
  onChange,
}: {
  id: string;
  name: string;
  meta: string;
  note?: string;
  value: string;
  placeholder: string;
  rows: number;
  error?: string;
  disabled: boolean;
  accept: string;
  onChange: (value: string) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        haptic("selection");
        onChange(text);
      }
    } catch {
      // No clipboard permission: the box takes ⌘V as ever.
      document.getElementById(id)?.focus();
    }
  };
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label htmlFor={id} className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-medium text-ink">{name}</span>
          <span className="text-xs text-ink-3">{meta}</span>
        </label>
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
            <input
              ref={file}
              type="file"
              accept={accept}
              className="hidden"
              tabIndex={-1}
              onChange={async (event) => {
                const picked = event.target.files?.[0];
                event.target.value = "";
                if (picked) onChange(await picked.text());
              }}
            />
          </span>
        )}
      </div>
      {note && (
        <p id={noteId} className="text-xs text-ink-3">
          {note}
        </p>
      )}
      <Squircle radius={radius.textarea}>
        <textarea
          id={id}
          value={value}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [note ? noteId : "", error ? `${id}-error` : ""]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "hb-lacquer-code block w-full resize-y px-3.5 py-3 font-mono text-[13px] leading-5 outline-none",
            error && "hb-lacquer-invalid",
          )}
        />
      </Squircle>
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

/** 在线检查's result, row by row (07 §5). */
function CheckResult({ check }: { check: JudgeCheck }) {
  const loaded = check.problems.length === 0 && !check.loadProblem;
  const passedTests = check.tests.filter((test) => test.passed).length;
  return (
    <ul className="grid gap-1.5" aria-label="在线检查的结果">
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
      {check.unstable.length > 0 && (
        <li className="pl-6 text-xs text-warning">
          两次跑出的结果不一样：{check.unstable.join("、")}
          。用了真随机，重放会对不上。
        </li>
      )}
      {check.slowestMs !== null && (
        <li className="pl-6 text-xs text-ink-3">
          最慢一次 {check.slowestMs} 毫秒
        </li>
      )}
      <li className="pl-6 text-xs text-ink-3">
        指纹 <span className="font-mono break-all">{check.fingerprint}</span>
      </li>
    </ul>
  );
}

/**
 * ③ 代码 (代码判定红包, in place of 怎么领): the prompt shown to claimants,
 * judge.js and tests.json pasted, and 在线检查 in the sandbox the claims will
 * use (docs/programmable-hongbao-design.md §5).
 */
export function CodeStep({
  form,
  update,
  errorOf,
  locked,
  checkState,
  checking,
  checksLeft,
  gated,
  onCheck,
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
  checkState: CodeCheckState;
  checking: boolean;
  /** 在线检查 left today; undefined while unknown. */
  checksLeft?: number;
  /** 保存并开放 was stopped by it: said in red under the button. */
  gated: boolean;
  onCheck: () => void;
  openSheet: (group: "timing" | "scope") => void;
  deadline?: string;
  timingError?: string;
  scopeError?: string;
  timeLine: string;
  scopeLine: string;
}) {
  const set = (key: "prompt" | "code" | "tests") => (value: string) =>
    update((current) => ({
      ...current,
      judge: { ...current.judge, [key]: value },
    }));
  const result =
    checkState.kind === "failed"
      ? checkState.check
      : checkState.kind === "passed"
        ? checkState.check
        : undefined;
  const noChecks = checksLeft === 0;
  return (
    <div className="flex flex-col gap-5">
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
      <CodeBox
        id="hb-code-code"
        name="judge.js"
        meta={form.judge.code ? sizeOf(form.judge.code) : "还没贴"}
        value={form.judge.code}
        placeholder={
          "export function judge(submission, tools) {\n  // 返回 { ok, amount, message, state }\n}"
        }
        rows={12}
        error={errorOf("hb-code-code")}
        disabled={locked}
        accept=".js,.mjs,text/javascript"
        onChange={set("code")}
      />
      <CodeBox
        id="hb-code-tests"
        name="tests.json"
        meta={testCount(form.judge.tests)}
        note="只是数据，不算进代码，不公开。"
        value={form.judge.tests}
        placeholder={
          '[\n  { "name": "答对", "input": "flag{…}", "expect": { "ok": true } }\n]'
        }
        rows={6}
        error={errorOf("hb-code-tests")}
        disabled={locked}
        accept=".json,application/json"
        onChange={set("tests")}
      />
      {!locked && (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Squircle radius={radius.input}>
              <button
                id="hb-code-check"
                type="button"
                onClick={onCheck}
                disabled={
                  checking || noChecks || !form.judge.code.trim() || locked
                }
                className="hb-lacquer-button inline-flex h-9 items-center gap-1.5 px-4 text-sm font-semibold disabled:opacity-60"
              >
                {checking ? "正在检查…" : "在线检查"}
              </button>
            </Squircle>
            <span className="min-w-0 flex-1 text-xs text-ink-3">
              在线上同一个沙箱里跑你的测试；只改测试不算新代码
              {checksLeft !== undefined && ` · 今天还能检查 ${checksLeft} 次`}
            </span>
          </div>
          <Reveal show={checkState.kind === "passed" && !result}>
            <p className="flex items-center gap-1.5 text-sm text-success">
              <Check className="size-4" aria-hidden="true" />
              这份代码和测试已经通过在线检查。
            </p>
          </Reveal>
          <Reveal show={Boolean(result)}>
            {result && <CheckResult check={result} />}
          </Reveal>
          <Reveal show={checkState.kind === "unchecked" && checkState.changed}>
            <p className="text-xs text-warning">
              代码或测试改过了，要再检查一次。
            </p>
          </Reveal>
          <Reveal show={gated && checkState.kind !== "passed"}>
            <p className="text-sm text-danger">代码还没通过在线检查</p>
          </Reveal>
        </div>
      )}
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
        开放后代码不能改；结束后所有人都能看到代码。
      </p>
    </div>
  );
}
