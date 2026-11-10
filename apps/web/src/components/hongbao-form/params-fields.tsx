import {
  type AmountUnit,
  amountToMinor,
  formatUnitAmount,
  type JudgeNetworkEntry,
  type JudgeParam,
  LDC_UNIT,
  parseUnitAmount,
} from "@hb/contracts";
import { Plus, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { readAddress } from "../../../../../kit/runtime/network.mjs";
import { cn } from "../../lib/cn";
import { addressLabel, ParamTags } from "../judges/judge-bits";
import { Button } from "../ui/button";
import { Field, Segmented, Switch, TextArea, TextInput } from "../ui/field";

// 判定器的参数 (docs/judge-square-design.md §3, §14.4): the form its code
// declares, drawn by the site. Values are kept as the code gets them —
// numbers and 分 once they read as such, the text typed until then — so a
// draft saves what was typed, and the site's rules say what is wrong.

type Values = Record<string, unknown>;
type Column = Extract<JudgeParam, { type: "table" }>["columns"][number];

/** 2000 → "20.00". */
const ldc = (minor: number) =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/** What an integer box holds, as the code would get it. */
function integerOf(text: string): number | string {
  return /^-?\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : text;
}

/**
 * What an LDC box holds: 分, or the text when it is no amount — the rule
 * (amountToMinor) throws on 0 and the like, and is read as it renders, so
 * it is caught here and the field says what is wrong under its box.
 */
function moneyOf(text: string): number | string {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return text;
  try {
    return amountToMinor(text.trim());
  } catch {
    return text;
  }
}

/**
 * The unit a 红包's money params are in (docs/third-party-points-design.md
 * §10): LDC's 分, or for a 三方积分红包 whole 最小单位 — what a judge that
 * declares meta.points counts. The form gives it; elsewhere it is LDC.
 */
export const ParamsUnitContext = createContext<AmountUnit>(LDC_UNIT);

/** A 三方积分 box: whole steps of its 最小单位, or the text. */
function unitsOf(text: string, unit: AmountUnit): number | string {
  const minor = parseUnitAmount(text, unit.step);
  return minor === null ? text : minor / unit.step;
}

/** A value shown in its box: amounts in LDC, or the 红包's unit. */
function shown(
  value: unknown,
  type: "text" | "integer" | "money",
  unit: AmountUnit = LDC_UNIT,
) {
  if (value === undefined || value === null) return "";
  if (type === "money" && typeof value === "number")
    return unit.step === 1
      ? ldc(value)
      : formatUnitAmount(value * unit.step, unit.step);
  return String(value);
}

/**
 * A number or amount box: what is typed stays as typed (1.5 is not put
 * back as 1.50 under the caret); the value follows it.
 */
function NumberInput({
  id,
  type,
  value,
  onChange,
  disabled,
  invalid,
  label,
}: {
  id: string;
  type: "integer" | "money";
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  invalid: boolean;
  label?: string;
}) {
  const unit = useContext(ParamsUnitContext);
  const money = (typed: string) =>
    unit.step === 1 ? moneyOf(typed) : unitsOf(typed, unit);
  const [text, setText] = useState(() => shown(value, type, unit));
  // Changed from outside (another version's defaults): show that.
  const read =
    text.trim() === ""
      ? null
      : type === "money"
        ? money(text)
        : integerOf(text);
  const outside =
    (value ?? null) !== read && !(value === undefined && read === null);
  return (
    <TextInput
      id={id}
      inputMode={type === "money" ? "decimal" : "numeric"}
      value={outside ? shown(value, type, unit) : text}
      disabled={disabled}
      invalid={invalid}
      aria-label={label}
      autoComplete="off"
      suffix={type === "money" ? unit.unit : undefined}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        onChange(
          next.trim() === ""
            ? null
            : type === "money"
              ? money(next)
              : integerOf(next),
        );
      }}
    />
  );
}

/** One line of a list, or a table's rows: added and taken away. */
function Rows({
  count,
  add,
  remove,
  addLabel,
  disabled,
  children,
}: {
  count: number;
  add: () => void;
  remove: (index: number) => void;
  addLabel: string;
  disabled: boolean;
  children: (index: number) => React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: count }, (_, index) => (
        // Rows have no identity of their own: their place is it.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={index} className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">{children(index)}</div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`删掉第 ${index + 1} 项`}
            disabled={disabled}
            onClick={() => remove(index)}
          >
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button size="xs" disabled={disabled} onClick={add}>
          <Plus />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function cellInput(
  column: Column,
  id: string,
  value: unknown,
  onChange: (value: unknown) => void,
  disabled: boolean,
  label: string,
) {
  return column.type === "text" ? (
    <TextInput
      id={id}
      value={shown(value, "text")}
      disabled={disabled}
      aria-label={label}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
    />
  ) : (
    <NumberInput
      id={id}
      type={column.type}
      value={value}
      disabled={disabled}
      invalid={false}
      label={label}
      onChange={onChange}
    />
  );
}

/** One declared item's control. */
function ParamControl({
  item,
  id,
  value,
  onChange,
  disabled,
  invalid,
}: {
  item: JudgeParam;
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  switch (item.type) {
    case "text":
      return (
        <TextInput
          id={id}
          value={shown(value, "text")}
          disabled={disabled}
          invalid={invalid}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "url":
      // 地址 (docs/judge-address-design.md §4): put as it is kept, ending
      // in /, once left; what is wrong is said under it as it is typed.
      return (
        <TextInput
          id={id}
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://…"
          value={shown(value, "text")}
          disabled={disabled}
          invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            const read = readAddress(value);
            if ("address" in read && read.address !== value)
              onChange(read.address);
          }}
        />
      );
    case "textarea":
      return (
        <TextArea
          id={id}
          value={shown(value, "text")}
          disabled={disabled}
          invalid={invalid}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "integer":
    case "money":
      return (
        <NumberInput
          id={id}
          type={item.type}
          value={value}
          disabled={disabled}
          invalid={invalid}
          onChange={onChange}
        />
      );
    case "choice":
      return item.options.length <= 4 ? (
        <div id={id} tabIndex={-1} className="outline-none">
          <Segmented
            label={item.label}
            value={typeof value === "string" ? value : ""}
            options={item.options.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            disabled={disabled}
            onChange={onChange}
          />
        </div>
      ) : (
        <select
          id={id}
          className="field h-11 px-3.5 text-base text-ink"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">请选择</option>
          {item.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case "list": {
      const items = Array.isArray(value) ? (value as unknown[]) : [];
      return (
        <div id={id} tabIndex={-1} className="outline-none">
          <Rows
            count={items.length}
            add={() => onChange([...items, ""])}
            remove={(index) =>
              onChange(items.filter((_, place) => place !== index))
            }
            addLabel="加一项"
            disabled={disabled}
          >
            {(index) => (
              <TextInput
                value={shown(items[index], "text")}
                disabled={disabled}
                aria-label={`${item.label} 第 ${index + 1} 项`}
                autoComplete="off"
                onChange={(event) =>
                  onChange(
                    items.map((entry, place) =>
                      place === index ? event.target.value : entry,
                    ),
                  )
                }
              />
            )}
          </Rows>
        </div>
      );
    }
    case "table": {
      const rows = Array.isArray(value)
        ? (value as Record<string, unknown>[])
        : [];
      const empty = () =>
        Object.fromEntries(item.columns.map((column) => [column.key, null]));
      return (
        <div id={id} tabIndex={-1} className="outline-none">
          <Rows
            count={rows.length}
            add={() => onChange([...rows, empty()])}
            remove={(index) =>
              onChange(rows.filter((_, place) => place !== index))
            }
            addLabel="加一行"
            disabled={disabled}
          >
            {(index) => (
              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${item.columns.length}, minmax(0, 1fr))`,
                }}
              >
                {item.columns.map((column) =>
                  cellInput(
                    column,
                    `${id}-${index}-${column.key}`,
                    rows[index]?.[column.key],
                    (cell) =>
                      onChange(
                        rows.map((row, place) =>
                          place === index
                            ? { ...row, [column.key]: cell }
                            : row,
                        ),
                      ),
                    disabled,
                    `第 ${index + 1} 行的${column.label}`,
                  ),
                )}
              </div>
            )}
          </Rows>
        </div>
      );
    }
    default:
      return null;
  }
}

/** A table's column names, over its rows. */
function ColumnNames({ item }: { item: JudgeParam }) {
  if (item.type !== "table") return null;
  return (
    <div
      aria-hidden="true"
      className="grid gap-2 pr-10 text-xs text-ink-3"
      style={{
        gridTemplateColumns: `repeat(${item.columns.length}, minmax(0, 1fr))`,
      }}
    >
      {item.columns.map((column) => (
        <span key={column.key} className="truncate px-1">
          {column.label}
        </span>
      ))}
    </div>
  );
}

/** 怎么填 ↗ (docs/judge-address-design.md §3): the item's guide, in a new tab. */
function Guide({ item }: { item: JudgeParam }) {
  if (!item.guide) return null;
  return (
    <a
      href={item.guide}
      target="_blank"
      rel="noreferrer"
      className="text-accent-ink hover:underline"
    >
      怎么填 ↗
    </a>
  );
}

/** An item's hint, then what more it says, a line each. */
function hintLines(...lines: ReactNode[]) {
  const shownLines = lines.filter(Boolean);
  if (shownLines.length === 0) return undefined;
  return (
    <>
      {shownLines.map((line, index) => (
        // The lines are fixed for the item: their place is it.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </>
  );
}

/**
 * 密钥 (docs/judge-key-design.md §3): a password box, or 已填写 once one is
 * kept (never shown again) with 换一个; what it is and where it goes under
 * it. It may change after opening too.
 */
function KeyField({
  item,
  params,
  id,
  error,
  filled,
  typed,
  onType,
}: {
  item: Extract<JudgeParam, { type: "key" }>;
  params: readonly JudgeParam[];
  id: string;
  error: string | undefined;
  filled: boolean;
  typed: string | undefined;
  onType: (key: string, value: string | null) => void;
}) {
  const kept = filled && typed === undefined;
  // To an 地址参数 (docs/judge-address-design.md §4): the one filled above.
  const to =
    typeof item.to === "string"
      ? item.to
      : `你填的${addressLabel(params, item.to.param)}`;
  return (
    <div className="grid min-w-0 gap-1.5 @min-[30rem]/params:col-span-2">
      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            {item.label}
            {item.required === false && (
              <span className="text-ink-3">（选填）</span>
            )}
            <ParamTags item={item} params={params} />
          </span>
        }
        htmlFor={kept ? undefined : id}
        hint={hintLines(
          item.hint,
          <>
            只会发给{typeof item.to === "string" && " "}
            <span className="break-all">{to}</span>
            ，判定器代码看不到；保存后不再显示，红包结束后删除。调用的费用从这个密钥扣。
          </>,
          item.guide && <Guide item={item} />,
        )}
        error={error}
      >
        {kept ? (
          <div
            id={id}
            tabIndex={-1}
            className="flex h-11 items-center gap-3 outline-none"
          >
            <span className="text-sm text-ink-2">已填写</span>
            <Button size="xs" onClick={() => onType(item.key, "")}>
              换一个
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <TextInput
              id={id}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder="填你自己的密钥"
              className="min-w-0 flex-1"
              value={typed ?? ""}
              invalid={Boolean(error)}
              onChange={(event) => onType(item.key, event.target.value)}
            />
            {filled && (
              <Button
                size="xs"
                variant="quiet"
                onClick={() => onType(item.key, null)}
              >
                不换了
              </Button>
            )}
          </div>
        )}
      </Field>
    </div>
  );
}

/**
 * The params form: each item with its name and line as the code wrote
 * them, short ones two to a row, each tagged with when it is shown (结束后
 * 公开, or a 密钥's 不公开).
 */
export function ParamsFields({
  params,
  values,
  onChange,
  errorOf,
  locked,
  keys,
  network = null,
  ownId,
  idPrefix = "hb-param-",
}: {
  params: JudgeParam[];
  values: Values;
  onChange: (key: string, value: unknown) => void;
  errorOf: (key: string) => string | undefined;
  locked: boolean;
  /**
   * 密钥 (docs/judge-key-design.md §3): those kept, what is typed, and
   * typing (null: keep the one kept). Without it they are left out (试一试
   * never goes online).
   */
  keys?: {
    filled: readonly string[];
    typed: Readonly<Record<string, string>>;
    onType: (key: string, value: string | null) => void;
  };
  /** Its 联网, for what an 地址参数 is asked for. */
  network?: readonly JudgeNetworkEntry[] | null;
  /**
   * The sender's LINUX DO 数字 ID, under an 地址参数 (a service they deploy
   * is told it, docs/judge-address-design.md §4); none in 试一试.
   */
  ownId?: string;
  /**
   * The form's own ids (its problems go to them) unless another place
   * shows these too: the 判定器页's 试一试, beside the form while the pages
   * change.
   */
  idPrefix?: string;
}) {
  const short = (item: JudgeParam) =>
    item.type === "integer" ||
    item.type === "money" ||
    (item.type === "text" && (item.maxLength ?? 200) <= 40);
  return (
    <div className="@container/params">
      <div className="grid gap-4 @min-[30rem]/params:grid-cols-2">
        {params.map((item) => {
          const error = errorOf(item.key);
          if (item.type === "key")
            return keys ? (
              <KeyField
                key={item.key}
                item={item}
                params={params}
                id={`${idPrefix}${item.key}`}
                error={error}
                filled={keys.filled.includes(item.key)}
                typed={keys.typed[item.key]}
                onType={keys.onType}
              />
            ) : null;
          const label = (
            <span className="inline-flex items-center gap-1.5">
              {item.label}
              {item.required === false && (
                <span className="text-ink-3">（选填）</span>
              )}
              <ParamTags item={item} params={params} />
            </span>
          );
          // 地址 (docs/judge-address-design.md §4): what it is asked for,
          // that it is shown, and who the sender is to a service they deploy.
          const more =
            item.type === "url"
              ? [
                  `${
                    (network ?? []).some(
                      (entry) =>
                        typeof entry !== "string" &&
                        "param" in entry &&
                        entry.param === item.key,
                    )
                      ? "判定器会请求这个地址，"
                      : ""
                  }领的人看得到它。开放后不能改。`,
                  ownId &&
                    `你的 LINUX DO 数字 ID 是 ${ownId}，部署说明要你填时用它。`,
                ]
              : [];
          if (item.type === "switch")
            return (
              <div
                key={item.key}
                id={`${idPrefix}${item.key}`}
                tabIndex={-1}
                className="outline-none @min-[30rem]/params:col-span-2"
              >
                <Switch
                  label={label}
                  description={
                    error ??
                    hintLines(item.hint, item.guide && <Guide item={item} />)
                  }
                  checked={values[item.key] === true}
                  disabled={locked}
                  onChange={(checked) => onChange(item.key, checked)}
                />
              </div>
            );
          // 选项联动 (judge-square §3): the chosen option's own hint, and
          // the params it sets, set as it is chosen.
          const chosen =
            item.type === "choice"
              ? item.options.find((option) => option.value === values[item.key])
              : undefined;
          return (
            <div
              key={item.key}
              className={cn(
                "grid min-w-0 gap-1.5",
                !short(item) && "@min-[30rem]/params:col-span-2",
              )}
            >
              <ColumnNames item={item} />
              <Field
                label={label}
                htmlFor={
                  item.type === "list" || item.type === "table"
                    ? undefined
                    : `${idPrefix}${item.key}`
                }
                hint={hintLines(
                  chosen?.hint ?? item.hint,
                  ...more,
                  item.guide && <Guide item={item} />,
                )}
                error={error}
              >
                <ParamControl
                  item={item}
                  id={`${idPrefix}${item.key}`}
                  value={values[item.key]}
                  disabled={locked}
                  invalid={Boolean(error)}
                  onChange={(value) => {
                    onChange(item.key, value);
                    if (item.type !== "choice") return;
                    const set = item.options.find(
                      (option) => option.value === value,
                    )?.set;
                    for (const [key, next] of Object.entries(set ?? {}))
                      if (params.some((other) => other.key === key))
                        onChange(key, next);
                  }}
                />
              </Field>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The values a version's params start from: those still declared as they
 * were, the rest their defaults (§14.4: changing versions keeps what fits),
 * or what the option chosen to start with sets (选项联动, judge-square §3;
 * the two agree where both are written).
 */
export function paramsFor(params: JudgeParam[], current: Values): Values {
  const next: Values = {};
  // 密钥 are never among the params (docs/judge-key-design.md).
  for (const item of params)
    if (item.type === "key") continue;
    else if (Object.hasOwn(current, item.key))
      next[item.key] = current[item.key];
    else if ("default" in item && item.default !== undefined)
      next[item.key] = item.default;
    else if (item.type === "list" || item.type === "table") next[item.key] = [];
  for (const item of params) {
    if (item.type !== "choice" || Object.hasOwn(current, item.key)) continue;
    const set = item.options.find(
      (option) => option.value === item.default,
    )?.set;
    for (const [key, value] of Object.entries(set ?? {}))
      if (
        !Object.hasOwn(current, key) &&
        params.some((other) => other.key === key)
      )
        next[key] = value;
  }
  return next;
}
