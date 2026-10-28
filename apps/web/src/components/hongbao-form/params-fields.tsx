import { amountToMinor, type JudgeParam } from "@hb/contracts";
import { Lock, Plus, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Field, Segmented, Switch, TextArea, TextInput } from "../ui/field";
import { TagHint } from "../ui/tag-hint";

// 判定器的参数 (docs/judge-square-design.md §3, §14.4): the form its code
// declares, drawn by the site. Values are kept as the code gets them —
// numbers and 分 once they read as such, the text typed until then — so a
// draft saves what was typed, and the site's rules say what is wrong.

type Values = Record<string, unknown>;
type Column = Extract<JudgeParam, { type: "table" }>["columns"][number];

const SECRET = "开放后保密，结束后公开。回复里会不会透露它，要看判定器的代码。";

/** 2000 → "20.00". */
const ldc = (minor: number) =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/** What an integer box holds, as the code would get it. */
function integerOf(text: string): number | string {
  return /^-?\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : text;
}

/** What an LDC box holds: 分, or the text when it is no amount. */
function moneyOf(text: string): number | string {
  return /^\d+(\.\d{1,2})?$/.test(text.trim())
    ? amountToMinor(text.trim())
    : text;
}

/** A value shown in its box: amounts in LDC. */
function shown(value: unknown, type: "text" | "integer" | "money") {
  if (value === undefined || value === null) return "";
  if (type === "money" && typeof value === "number") return ldc(value);
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
  const [text, setText] = useState(() => shown(value, type));
  // Changed from outside (another version's defaults): show that.
  const read =
    text.trim() === ""
      ? null
      : type === "money"
        ? moneyOf(text)
        : integerOf(text);
  const outside =
    (value ?? null) !== read && !(value === undefined && read === null);
  return (
    <TextInput
      id={id}
      inputMode={type === "money" ? "decimal" : "numeric"}
      value={outside ? shown(value, type) : text}
      disabled={disabled}
      invalid={invalid}
      aria-label={label}
      autoComplete="off"
      suffix={type === "money" ? "LDC" : undefined}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        onChange(
          next.trim() === ""
            ? null
            : type === "money"
              ? moneyOf(next)
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
  value,
  onChange,
  disabled,
  invalid,
}: {
  item: JudgeParam;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const id = `hb-param-${item.key}`;
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

/**
 * The params form: each item with its name and line as the code wrote
 * them, short ones two to a row; a secret one with its lock.
 */
export function ParamsFields({
  params,
  values,
  onChange,
  errorOf,
  locked,
}: {
  params: JudgeParam[];
  values: Values;
  onChange: (key: string, value: unknown) => void;
  errorOf: (key: string) => string | undefined;
  locked: boolean;
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
          const label = (
            <span className="inline-flex items-center gap-1">
              {item.label}
              {item.required === false && (
                <span className="text-ink-3">（选填）</span>
              )}
              {item.secret && (
                <TagHint hint={SECRET} aria-label="保密" className="text-ink-3">
                  <Lock className="size-3.5" aria-hidden="true" />
                </TagHint>
              )}
            </span>
          );
          if (item.type === "switch")
            return (
              <div
                key={item.key}
                id={`hb-param-${item.key}`}
                tabIndex={-1}
                className="outline-none @min-[30rem]/params:col-span-2"
              >
                <Switch
                  label={label}
                  description={error ?? item.hint}
                  checked={values[item.key] === true}
                  disabled={locked}
                  onChange={(checked) => onChange(item.key, checked)}
                />
              </div>
            );
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
                    : `hb-param-${item.key}`
                }
                hint={item.hint}
                error={error}
              >
                <ParamControl
                  item={item}
                  value={values[item.key]}
                  disabled={locked}
                  invalid={Boolean(error)}
                  onChange={(value) => onChange(item.key, value)}
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
 * were, the rest their defaults (§14.4: changing versions keeps what fits).
 */
export function paramsFor(params: JudgeParam[], current: Values): Values {
  const next: Values = {};
  for (const item of params)
    if (Object.hasOwn(current, item.key)) next[item.key] = current[item.key];
    else if (item.default !== undefined) next[item.key] = item.default;
    else if (item.type === "list" || item.type === "table") next[item.key] = [];
  return next;
}
