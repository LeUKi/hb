import { ChevronDown, DoorOpen, KeyRound, Plus } from "lucide-react";
import { useRef, useState } from "react";
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
  LockNote,
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
import type { SettingsGroup } from "./steps";

type OpenSheet = (group: SettingsGroup) => void;

function ModeCard({
  option,
  selected,
  onPick,
  disabled,
}: {
  option: (typeof modeOptions)[number];
  selected: boolean;
  onPick: () => void;
  disabled: boolean;
}) {
  const Icon = option.icon;
  return (
    <Squircle radius={radius.card}>
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled && !selected}
        onClick={onPick}
        className="choice grid content-start gap-2 p-4 text-left"
      >
        <Squircle radius={10}>
          <span
            className={cn(
              "choice-icon grid size-9 place-items-center bg-fill-2 text-ink-2",
              selected && "bg-accent-soft",
            )}
          >
            <Icon className="size-[18px]" aria-hidden="true" />
          </span>
        </Squircle>
        <span className="grid gap-0.5">
          <span className="text-base font-semibold text-ink">
            {option.title}
          </span>
          <span className="text-sm text-ink-3">{option.description}</span>
        </span>
      </button>
    </Squircle>
  );
}

/** ① 玩法: the two most used as big cards; the other two behind 更多玩法. */
export function ModeStep({
  form,
  onPick,
  locked,
}: {
  form: FormState;
  onPick: (mode: RewardMode) => void;
  locked: boolean;
}) {
  const rare = modeOptions.some(
    (option) => option.more && option.value === form.mode,
  );
  const [more, setMore] = useState(rare);
  const cards = (rareOnes: boolean) => (
    <fieldset
      aria-label={rareOnes ? "更多玩法" : "玩法"}
      className="grid grid-cols-2 gap-2.5"
    >
      {modeOptions
        .filter((option) => Boolean(option.more) === rareOnes)
        .map((option) => (
          <ModeCard
            key={option.value}
            option={option}
            selected={form.mode === option.value}
            disabled={locked}
            onPick={() => onPick(option.value)}
          />
        ))}
    </fieldset>
  );
  return (
    <div className="flex flex-col gap-2.5">
      {cards(false)}
      {!locked && (
        <button
          type="button"
          aria-expanded={more || rare}
          onClick={() => setMore((value) => !value)}
          disabled={rare}
          className="flex w-fit items-center gap-1 px-1 text-sm text-ink-2 hover:text-ink disabled:cursor-default disabled:hover:text-ink-2"
        >
          更多玩法
          <ChevronDown
            className={cn(
              "size-4 transition-transform",
              (more || rare) && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      )}
      <Reveal show={more || rare}>{cards(true)}</Reveal>
      {locked && <LockNote>开放后不能修改。</LockNote>}
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
      {locked && <LockNote>开放后不能修改。</LockNote>}
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
          <LockNote>开放后不能修改。</LockNote>
        </>
      ) : (
        <QuietLine
          id="hb-quiet-timing"
          text={time}
          error={timingError}
          onOpen={() => openSheet("timing")}
        />
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
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  openSheet: OpenSheet;
  /** What 更多设置 holds now ("附言未填 · 不加入广场 · …"). */
  moreLine: string;
  moreError?: string;
}) {
  const [note, setNote] = useState(form.beforeInfo.trim().length > 0);
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
    </div>
  );
}
