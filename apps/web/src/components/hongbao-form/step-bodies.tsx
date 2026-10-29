import { normalizePageUrl } from "@hb/contracts";
import { DoorOpen, KeyRound, Plus } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "../../lib/cn";
import { ChoiceCards, Field, TextInput } from "../ui/field";
import { Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import {
  AmountFields,
  algorithmLabels,
  counter,
  type ErrorOf,
  FundingChoice,
  LockedNote,
  modeOptions,
  PasswordList,
  QuietLine,
  type Update,
} from "./fields";
import {
  defaultTitle,
  type FormState,
  LIMITS,
  type RewardMode,
  timingLine,
} from "./form-state";
import { NoteEditor } from "./note-editor";
import { scopeLine } from "./scope-fields";
import type { SettingsGroup } from "./steps";

type OpenSheet = (group: SettingsGroup) => void;

function ModeCard({
  option,
  selected,
  onPick,
  disabled,
  stacked = false,
  checking = false,
  note,
}: {
  option: (typeof modeOptions)[number];
  selected: boolean;
  onPick: () => void;
  disabled: boolean;
  /** Its words under its icon, where the two groups sit side by side. */
  stacked?: boolean;
  /** Whether it can be sent is being read: grey, the sheen across it. */
  checking?: boolean;
  /** Why it cannot be picked now, in place of its line. */
  note?: string;
}) {
  const Icon = option.icon;
  return (
    <Squircle radius={radius.card}>
      <button
        type="button"
        aria-pressed={selected}
        aria-busy={checking || undefined}
        disabled={disabled && !selected}
        onClick={onPick}
        className={cn(
          "choice flex h-full items-center gap-2.5 p-3 text-left",
          option.code && "choice-settle",
          checking && "loading-sheen",
          stacked &&
            "@min-[34rem]/modes:flex-col @min-[34rem]/modes:items-start @min-[34rem]/modes:justify-center @min-[34rem]/modes:gap-3 @min-[34rem]/modes:p-4",
        )}
      >
        <Squircle radius={10}>
          <span
            className={cn(
              "choice-icon grid size-8 shrink-0 place-items-center",
              // 代码判定: black lacquer and gold (05 §14), picked or not.
              option.value === "code"
                ? "hb-lacquer-chip"
                : cn("bg-fill-2 text-ink-2", selected && "bg-accent-soft"),
            )}
          >
            <Icon className="size-[18px]" aria-hidden="true" />
          </span>
        </Squircle>
        <span className="grid min-w-0 gap-0.5">
          <span className="text-base font-semibold text-ink">
            {option.title}
          </span>
          <span className="text-sm text-balance text-ink-3">
            {note ?? option.description}
          </span>
          {checking && <span className="sr-only">正在确认能不能发</span>}
        </span>
      </button>
    </Squircle>
  );
}

/**
 * Whether 代码判定红包 can be sent now (its switch): being read, open,
 * closed, or not read.
 */
export type CodeOffer = "checking" | "open" | "closed" | "unknown";

/**
 * ① 玩法 (07 §5, 2026-10-28): 经典玩法 two by two; 代码判定 apart as 进阶玩法,
 * always in its place (2026-10-29), clickable once it can be sent. Side by side, two to
 * one, where they fit, 代码判定 standing as tall as the two rows; one above
 * the other where they do not.
 */
export function ModeStep({
  form,
  onPick,
  locked,
  codeOffer,
}: {
  form: FormState;
  onPick: (mode: RewardMode) => void;
  locked: boolean;
  /** Whether 代码判定红包 can be sent now (its switch). */
  codeOffer: CodeOffer;
}) {
  const classicId = useId();
  const advancedId = useId();
  const card = (option: (typeof modeOptions)[number]) => (
    <ModeCard
      key={option.value}
      option={option}
      selected={form.mode === option.value}
      disabled={locked}
      onPick={() => onPick(option.value)}
    />
  );
  const classic = modeOptions.filter((option) => !option.code);
  const advanced = modeOptions.filter((option) => option.code);
  return (
    <div className="flex flex-col gap-2.5">
      <fieldset aria-label="玩法" className="@container/modes min-w-0">
        <div className="grid @min-[34rem]/modes:grid-cols-[2fr_auto_1fr] @min-[34rem]/modes:gap-x-3">
          <fieldset
            aria-labelledby={classicId}
            className="flex min-w-0 flex-col gap-2.5"
          >
            <p id={classicId} className="px-1 text-xs text-ink-3">
              经典玩法
            </p>
            <div className="grid gap-2.5 @min-[22rem]/modes:grid-cols-2">
              {classic.map((option) => card(option))}
            </div>
          </fieldset>
          <span
            aria-hidden="true"
            className="hidden w-px bg-line @min-[34rem]/modes:mt-10 @min-[34rem]/modes:mb-4 @min-[34rem]/modes:block"
          />
          <fieldset
            aria-labelledby={advancedId}
            className="mt-5 flex min-w-0 flex-col gap-2.5 @min-[34rem]/modes:mt-0"
          >
            <p id={advancedId} className="px-1 text-xs text-ink-3">
              进阶玩法
            </p>
            {/* Always in its place: grey while its switch is read, then
                clickable, or grey with why (07 §5, 2026-10-29). */}
            <div className="grid flex-1">
              {advanced.map((option) => (
                <ModeCard
                  key={option.value}
                  option={option}
                  selected={form.mode === option.value}
                  disabled={locked || codeOffer !== "open"}
                  checking={codeOffer === "checking"}
                  note={
                    codeOffer === "closed"
                      ? "暂时关闭"
                      : codeOffer === "unknown"
                        ? "没有确认到能不能发，刷新再试"
                        : undefined
                  }
                  onPick={() => onPick(option.value)}
                  stacked
                />
              ))}
            </div>
          </fieldset>
        </div>
      </fieldset>
      {locked && <LockedNote />}
    </div>
  );
}

/** What the 分法 line says for the current 玩法 (null: nothing to set). */
function splitLine(form: FormState) {
  switch (form.mode) {
    case "random":
      return `分法：${algorithmLabels[form.random.algorithm]}`;
    case "custom":
      return `发放顺序：${form.custom.order === "sequential" ? "按顺序" : "随机"}`;
    case "timed_draw":
      return `奖金：${algorithmLabels[form.draw.algorithm]}${
        form.draw.fillPool ? "，人数不足时发完奖池" : ""
      }`;
    default:
      return null;
  }
}

/** ② 发多少. */
export function AmountStep({
  form,
  update,
  errorOf,
  locked,
  openSheet,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  locked: boolean;
  openSheet: OpenSheet;
}) {
  const split = splitLine(form);
  return (
    <div className="grid gap-4">
      <FundingChoice form={form} update={update} locked={locked} />
      <AmountFields
        form={form}
        update={update}
        errorOf={errorOf}
        locked={locked}
      />
      {split &&
        (locked ? (
          <p className="px-1 text-sm text-ink-2">{split}</p>
        ) : (
          <QuietLine
            id="hb-quiet-split"
            text={split}
            onOpen={() => openSheet("split")}
          />
        ))}
      {locked && <LockedNote />}
    </div>
  );
}

/** ③ 怎么领: 口令 or none, and when it closes. */
export function ClaimStep({
  form,
  update,
  errorOf,
  locked,
  openSheet,
  deadline,
  timingError,
  scopeError,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  locked: boolean;
  openSheet: OpenSheet;
  /** An opened 红包's real deadline. */
  deadline?: string;
  /** The first problem with the timing (set in 更多设置). */
  timingError?: string;
  /** The first problem with 领取范围 (set in 更多设置). */
  scopeError?: string;
}) {
  const draw = form.mode === "timed_draw";
  const time =
    deadline ??
    `${timingLine(form)}${
      draw
        ? ` · ${form.draw.limit.trim() ? `报名上限 ${form.draw.limit.trim()} 人` : "报名不限"}`
        : ""
    }`;
  return (
    <div className="flex flex-col gap-4">
      <ChoiceCards
        label="怎么领"
        value={form.participation}
        disabled={locked}
        onChange={(participation) =>
          update((current) => ({
            ...current,
            participation,
            pageOnly: participation === "direct" ? false : current.pageOnly,
          }))
        }
        options={[
          {
            value: "password",
            title: "口令",
            description: "知道口令的人才能领，口令可以藏在帖子里",
            icon: KeyRound,
          },
          {
            value: "direct",
            title: "无需口令",
            description: draw ? "打开红包页就能报名" : "打开红包页就能领",
            icon: DoorOpen,
          },
        ]}
      />
      {/* Only a 口令红包 has 口令: the list opens and closes with the choice. */}
      <Reveal show={form.participation === "password"}>
        <PasswordList
          form={form}
          update={update}
          errorOf={errorOf}
          locked={locked}
        />
      </Reveal>
      {locked ? (
        <>
          <p className="px-1 text-sm text-ink-2">{time}</p>
          <p className="px-1 text-sm text-ink-2">{scopeLine(form)}</p>
          <LockedNote />
        </>
      ) : (
        <>
          <QuietLine
            id="hb-quiet-timing"
            text={time}
            error={timingError}
            onOpen={() => openSheet("timing")}
          />
          <QuietLine
            id="hb-quiet-scope"
            text={scopeLine(form)}
            error={scopeError}
            onOpen={() => openSheet("scope")}
          />
        </>
      )}
    </div>
  );
}

/** ④ 起个标题, an optional 说明, and the rest behind 更多设置. */
export function TitleStep({
  form,
  update,
  errorOf,
  openSheet,
  moreLine,
  moreError,
  schedule,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  openSheet: OpenSheet;
  /** What 更多设置 holds now ("附言未填 · 不加入广场 · …"). */
  moreLine: string;
  moreError?: string;
  /** 定时开放's line once a time is chosen (scheduled-opening §1), last. */
  schedule?: ReactNode;
}) {
  const [note, setNote] = useState(form.beforeInfo.trim().length > 0);
  // Filled in from elsewhere (a 判定器's 说明, judge-square §4.1): shown.
  if (!note && form.beforeInfo.trim().length > 0) setNote(true);
  const noteRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex flex-col gap-4">
      {/* The card's title says what this is: the label is only said. */}
      <Field
        label="标题（选填）"
        labelHidden
        htmlFor="hb-title"
        hint="选填，不填就用灰字的标题。"
        error={errorOf("hb-title")}
        aside={counter(form.title, LIMITS.title)}
      >
        <TextInput
          id="hb-title"
          value={form.title}
          placeholder={defaultTitle(form)}
          invalid={Boolean(errorOf("hb-title"))}
          onChange={(event) => {
            const title = event.target.value;
            update((current) => ({ ...current, title }));
          }}
        />
      </Field>
      {/* The button folds away as the 说明 opens in its place. */}
      <Reveal show={!note}>
        <button
          type="button"
          onClick={() => {
            // Shown and focused within the tap, so a phone's keyboard opens.
            flushSync(() => setNote(true));
            noteRef.current?.querySelector("textarea")?.focus();
          }}
          className="flex w-fit items-center gap-1 px-1 text-sm text-accent-ink"
        >
          <Plus className="size-4" aria-hidden="true" />
          加一段红包说明
        </button>
      </Reveal>
      <Reveal show={note}>
        <div ref={noteRef} className="pb-1">
          <NoteEditor
            id="hb-before-info"
            label="红包说明"
            hint="写在红包皮上，所有人都能看到。支持 Markdown（链接、加粗、列表）。"
            placeholder="例如：口令藏在帖子一楼的最后一句话里。"
            pageLink={normalizePageUrl(form.page) !== null}
            value={form.beforeInfo}
            error={errorOf("hb-before-info")}
            onChange={(beforeInfo) =>
              update((current) => ({ ...current, beforeInfo }))
            }
          />
        </div>
      </Reveal>
      <QuietLine
        id="hb-quiet-more"
        text={
          <span className="grid">
            <span className="text-ink">更多设置</span>
            <span className="truncate text-xs text-ink-3">{moreLine}</span>
          </span>
        }
        error={moreError}
        onOpen={() => openSheet("notes")}
      />
      {/* Once a time is chosen: it opens in place (the arrow chooses it). */}
      <Reveal show={Boolean(schedule)}>{schedule}</Reveal>
    </div>
  );
}
