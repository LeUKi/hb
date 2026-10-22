import {
  CLAIM_SCOPE_LIMITS,
  levelRangeText,
  scopeSentence,
  TRUST_LEVEL_MAX,
  TRUST_LEVEL_MIN,
} from "@hb/contracts";
import { Plus, UserCheck, Users, X } from "lucide-react";
import { useState } from "react";
import { usePerson } from "../../lib/people";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ChoiceCards, Field, Switch, TextInput } from "../ui/field";
import { PersonLine } from "../ui/person-line";
import { RangeSlider } from "../ui/range-slider";
import { Reveal } from "../ui/reveal";
import type { ErrorOf, Update } from "./fields";
import type { FormState, ScopeForm, ScopePerson } from "./form-state";

// 领取范围 (docs/claim-scope-design.md §5): everyone, or limited by 等级
// and/or by name, either letting someone in — the sentence under it says so.

const levels = Array.from(
  { length: TRUST_LEVEL_MAX - TRUST_LEVEL_MIN + 1 },
  (_, index) => `Lv${index + TRUST_LEVEL_MIN}`,
);

/** The 领取范围 in a line: the step's summary and its line to 更多设置. */
export function scopeLine(form: FormState) {
  const name = form.mode === "timed_draw" ? "报名范围" : "领取范围";
  const { scope } = form;
  if (!scope.limited) return `${name}：所有人`;
  const parts = [
    ...(scope.byLevel ? [levelRangeText(scope.levels)] : []),
    ...(scope.users.length > 0 ? [`指定的 ${scope.users.length} 人`] : []),
  ];
  return parts.length > 0
    ? `${name}：仅限 ${parts.join("或")}`
    : `${name}：限定（还没选）`;
}

/** One person added: face (when found), @用户名, and a way to take them off. */
function PersonChip({
  person,
  onRemove,
}: {
  person: ScopePerson;
  onRemove: () => void;
}) {
  const unknown = person.known === false;
  return (
    <span
      className="inline-flex h-8 items-center gap-1.5 rounded-full bg-fill pr-1 pl-1.5 text-sm"
      title={unknown ? "还没来过本站，按用户名认" : undefined}
    >
      <Avatar
        name={person.displayName ?? person.username}
        src={person.avatarUrl ?? null}
        size={20}
      />
      <span className={unknown ? "text-ink-3" : "text-ink"}>
        @{person.username}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        aria-label={`去掉 @${person.username}`}
        className="text-ink-3"
      >
        <X />
      </Button>
    </span>
  );
}

/** 指定的人: type a name, see who it is (as 转账 and 邀请 do), add them. */
function ScopePeople({
  scope,
  set,
  error,
}: {
  scope: ScopeForm;
  set: (change: Partial<ScopeForm>) => void;
  error?: string;
}) {
  const [typed, setTyped] = useState("");
  const name = typed.trim().replace(/^@/, "");
  const lookup = usePerson(name);
  const valid = /^[A-Za-z0-9_.-]{1,60}$/.test(name);
  const settled = valid && !lookup.isPlaceholderData && lookup.isSuccess;
  const found = settled ? lookup.data : undefined;
  const duplicate = scope.users.some(
    (user) => user.username.toLowerCase() === name.toLowerCase(),
  );
  const full = scope.users.length >= CLAIM_SCOPE_LIMITS.users;
  const ready = settled && !duplicate && !full;
  const add = () => {
    if (!ready) return;
    set({
      users: [
        ...scope.users,
        found
          ? {
              username: found.username,
              displayName: found.displayName,
              avatarUrl: found.avatarUrl,
              known: true,
            }
          : { username: name, known: false },
      ],
    });
    setTyped("");
  };
  // The hint stays under the input; the people added follow it.
  return (
    <div className="grid gap-2">
      <Field
        label="指定的人"
        htmlFor="hb-scope-user"
        hint={`填 LINUX DO 用户名，最多 ${CLAIM_SCOPE_LIMITS.users} 人。`}
        error={error}
      >
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <TextInput
              id="hb-scope-user"
              value={typed}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              prefix="@"
              placeholder="LINUX DO 用户名"
              onChange={(event) =>
                // The @ is already there: a pasted “@name” keeps just one.
                setTyped(event.target.value.replace(/^\s*@+/, ""))
              }
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                add();
              }}
            />
          </div>
          <Button
            onClick={add}
            aria-disabled={!ready || undefined}
            data-disabled={!ready || undefined}
          >
            <Plus />
            添加
          </Button>
        </div>
        <Reveal show={name.length > 0 && (settled || !valid)}>
          {!valid ? (
            <p className="text-xs text-danger">用户名只有字母、数字和 _ . -</p>
          ) : duplicate ? (
            <p className="text-xs text-ink-3">已经加过了。</p>
          ) : full ? (
            <p className="text-xs text-danger">
              最多指定 {CLAIM_SCOPE_LIMITS.users} 人。
            </p>
          ) : found ? (
            <PersonLine person={found} />
          ) : (
            <p className="text-xs text-ink-3">
              这个人还没来过本站，按用户名认。
            </p>
          )}
        </Reveal>
      </Field>
      <Reveal show={scope.users.length > 0}>
        <div className="flex flex-wrap gap-1.5">
          {scope.users.map((person) => (
            <PersonChip
              key={person.username.toLowerCase()}
              person={person}
              onRemove={() =>
                set({
                  users: scope.users.filter((user) => user !== person),
                })
              }
            />
          ))}
        </div>
      </Reveal>
    </div>
  );
}

/** The setting in 更多设置: 所有人, or 限定 by 等级 and/or 指定的人. */
export function ScopeFields({
  form,
  update,
  errorOf,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
}) {
  const draw = form.mode === "timed_draw";
  const verb = draw ? "报名" : "领";
  const { scope } = form;
  const set = (change: Partial<ScopeForm>) =>
    update((current) => ({
      ...current,
      scope: { ...current.scope, ...change },
    }));
  const levelsError = errorOf("hb-scope-levels");
  const sentence =
    scope.byLevel || scope.users.length > 0
      ? scopeSentence(
          {
            ...(scope.byLevel ? { levels: scope.levels } : {}),
            users: scope.users,
          },
          verb,
        )
      : null;
  return (
    <div className="grid gap-4">
      <ChoiceCards
        label={draw ? "报名范围" : "领取范围"}
        value={scope.limited ? "limited" : "all"}
        onChange={(value) =>
          // 限定 starts with 按等级 on (Lv1 and up): never empty to begin with.
          set(
            value === "limited" && !scope.byLevel && scope.users.length === 0
              ? { limited: true, byLevel: true }
              : { limited: value === "limited" },
          )
        }
        options={[
          {
            value: "all",
            title: "所有人",
            description: `谁都能${verb}`,
            icon: Users,
          },
          {
            value: "limited",
            title: "限定",
            description: "按等级，或指定的人",
            icon: UserCheck,
          },
        ]}
      />
      <Reveal show={scope.limited}>
        <div id="hb-scope" tabIndex={-1} className="grid gap-4 outline-none">
          <Switch
            label="按等级"
            description="LINUX DO 信任等级，按对方上次登录本站时算。"
            checked={scope.byLevel}
            onChange={(byLevel) => set({ byLevel })}
          />
          <Reveal show={scope.byLevel}>
            <div
              id="hb-scope-levels"
              tabIndex={-1}
              className="grid gap-2 outline-none"
            >
              <p className="text-sm text-ink">
                {scope.levels.min === scope.levels.max
                  ? `只有 Lv${scope.levels.min}`
                  : levelRangeText(scope.levels)}
              </p>
              <RangeSlider
                value={scope.levels}
                bounds={{ min: TRUST_LEVEL_MIN, max: TRUST_LEVEL_MAX }}
                onChange={(next) => set({ levels: next })}
                names={["最低等级", "最高等级"]}
                marks={levels}
                valueText={(level) => `Lv${level}`}
                invalid={Boolean(levelsError)}
              />
              <Reveal show={Boolean(levelsError)}>
                <p className="text-xs text-danger">{levelsError}</p>
              </Reveal>
            </div>
          </Reveal>
          <ScopePeople
            scope={scope}
            set={set}
            error={errorOf("hb-scope-user")}
          />
          {/* Both parts: “或”, said plainly, so nobody reads it as “and”. */}
          <Reveal show={sentence !== null || Boolean(errorOf("hb-scope"))}>
            <p
              className={`rounded-lg px-3 py-2 text-sm ${
                errorOf("hb-scope")
                  ? "bg-danger-soft text-danger"
                  : "bg-fill text-ink-2"
              }`}
            >
              {errorOf("hb-scope") ?? sentence}
            </p>
          </Reveal>
        </div>
      </Reveal>
    </div>
  );
}
