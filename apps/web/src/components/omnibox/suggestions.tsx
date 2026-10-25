import {
  ArrowRight,
  Braces,
  CornerDownLeft,
  History,
  KeyRound,
  MessagesSquare,
  Search,
  WandSparkles,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { useActivityFacts } from "../../lib/activity-facts";
import {
  type Command,
  type CommandFeatures,
  gateFor,
  matchCommands,
  type Role,
} from "../../lib/commands";
import { useReducedMotionPref } from "../../lib/motion";
import { optimizePassword } from "../../lib/password-rules";
import type { RecentEntry } from "../../lib/recent-inputs";
import { type EntryScheme, looksLikeAddress } from "../../lib/scheme";
import { useSessionUser } from "../../lib/session";
import { PlusMark } from "../balance/plus";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { Kbd } from "../ui/kbd";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { PasswordCount } from "./message";
import type { Scope, ScopeOffer } from "./state";

export type Suggestion =
  | { key: string; kind: "optimize"; value: string }
  | { key: string; kind: "claim"; activityId: string }
  | { key: string; kind: "verify"; activityId: string; length: number }
  | {
      key: string;
      kind: "discover";
      password: string;
      scoped: boolean;
      length: number;
    }
  | { key: string; kind: "jump"; activityId: string }
  | {
      key: string;
      kind: "topic";
      scheme: Extract<EntryScheme, { kind: "topic" }>;
    }
  | { key: string; kind: "recent"; entry: RecentEntry }
  | {
      key: string;
      /** This 红包, to type into: picking it sets the box's scope. */
      kind: "scope";
      activityId: string;
      purpose: "claim" | "verify" | "code";
      /** 口令 still to find, for verifying. */
      hidden: number;
    }
  | {
      key: string;
      kind: "command";
      command: Command;
      gate: null | "login";
      query: string;
    };

/** The 口令 with fixable characters cleaned up, or null when that changes nothing. */
export function optimizeTarget(value: string, scheme: EntryScheme) {
  if (scheme.kind !== "password" || scheme.valid || looksLikeAddress(value))
    return null;
  const optimized = optimizePassword(value);
  return optimized && optimized !== value ? optimized : null;
}

export function buildSuggestions(
  value: string,
  scheme: EntryScheme,
  scope: Scope,
  recent: RecentEntry[],
  role: Role,
  features: CommandFeatures,
  optimized: string | null,
  /** What the 红包 on screen offers an unscoped, empty box. */
  offer: ScopeOffer,
): Suggestion[] {
  if (scheme.kind === "command")
    return matchCommands(scheme.query, role, features).map((command) => ({
      key: `command:${command.id}`,
      kind: "command",
      command,
      gate: gateFor(command, role),
      query: scheme.query,
    }));
  // This 红包 first, then 最近输入 (production shows the last 10 of the
  // 100 it keeps).
  if (scheme.kind === "empty")
    return [
      ...(offer
        ? [
            {
              key: `scope:${offer.purpose}:${offer.id}`,
              kind: "scope" as const,
              activityId: offer.id,
              purpose: offer.purpose,
              hidden: offer.purpose === "verify" ? offer.hidden : 0,
            },
          ]
        : []),
      ...recent.slice(0, 10).map((entry) => ({
        key: `recent:${entry.password}`,
        kind: "recent" as const,
        entry,
      })),
    ];
  if (scheme.kind === "password") {
    // An invalid 口令 cannot be looked up; fixing it is the only action.
    if (!scheme.valid)
      return optimized
        ? [{ key: "optimize", kind: "optimize", value: optimized }]
        : [];
    // Verifying stays inside the 红包: no global lookup to fall back on.
    if (scope?.purpose === "verify")
      return [
        {
          key: "verify",
          kind: "verify",
          activityId: scope.id,
          length: scheme.length,
        },
      ];
    const items: Suggestion[] = [];
    if (scope)
      items.push({ key: "claim", kind: "claim", activityId: scope.id });
    items.push({
      key: "discover",
      kind: "discover",
      password: value,
      scoped: Boolean(scope),
      length: scheme.length,
    });
    return items;
  }
  if (scheme.kind === "topic") return [{ key: "topic", kind: "topic", scheme }];
  return [{ key: "jump", kind: "jump", activityId: scheme.activityId }];
}

const statusText = {
  matched: "已匹配",
  unmatched: "未匹配",
  unconfirmed: "未确认",
} as const;

const statusTone = {
  matched: "bg-success",
  unmatched: "bg-ink-3",
  unconfirmed: "bg-warning",
} as const;

export function relativeTime(at: number) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function Row({
  icon,
  children,
  meta,
  active,
}: {
  icon: ReactNode;
  children: ReactNode;
  meta?: ReactNode;
  active: boolean;
}) {
  return (
    <>
      <Squircle radius={10}>
        <span
          className={`grid size-8 shrink-0 place-items-center transition-colors ${
            active
              ? "bg-white text-ink raised"
              : "bg-fill text-ink-2 shadow-none"
          }`}
        >
          {icon}
        </span>
      </Squircle>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {meta}
      <CornerDownLeft
        aria-hidden="true"
        className={`size-4 shrink-0 text-ink-3 ${active ? "opacity-100" : "opacity-0"}`}
      />
    </>
  );
}

/** A 红包 to take part in; a 代码判定红包's mark is its gold braces. */
function ClaimIcon({ code }: { code: boolean }) {
  return code ? (
    <Braces className="size-4 text-gold-mark" />
  ) : (
    <HongbaoIcon className="size-4 text-accent" />
  );
}

export function GateChip() {
  return <StatusChip tone="accent">需登录</StatusChip>;
}

/** "/hist" → the typed part of the command name is emphasised. */
function CommandName({ name, query }: { name: string; query: string }) {
  const matched = query && name.startsWith(query) ? query.length : 0;
  return (
    <span className="shrink-0 font-mono text-sm">
      <span className="text-ink-3">/</span>
      <span className="text-accent-ink">{name.slice(0, matched)}</span>
      <span className="text-ink">{name.slice(matched)}</span>
    </span>
  );
}

export function SuggestionContent({
  item,
  active,
}: {
  item: Suggestion;
  active: boolean;
}) {
  const user = useSessionUser();
  // What the shell knows of a 红包 the row names (from the page's own read).
  const activity = useActivityFacts(
    "activityId" in item ? item.activityId : null,
  );
  if (item.kind === "optimize")
    return (
      <Row
        active={active}
        icon={<WandSparkles className="size-4 text-accent" />}
        meta={<Kbd className="shrink-0">Tab</Kbd>}
      >
        {/* The whole 口令 it becomes, to check: after the words in a wide
            window, on a line of its own in a narrow one. */}
        <span className="grid min-w-0 flex-1 gap-0.5 @wide/window:block">
          <span>
            <span className="font-medium text-ink">一键优化</span>
            <ArrowRight
              className="mx-2 inline size-3.5 align-[-0.125em] text-ink-3"
              aria-hidden="true"
            />
            <span className="sr-only">改为</span>
          </span>
          <span className="font-mono text-sm text-ink [overflow-wrap:anywhere]">
            {item.value}
          </span>
        </span>
      </Row>
    );
  if (item.kind === "command") {
    const Icon = item.command.icon;
    // 🐟额 PLUS: a gold fish and its tag (balance-design §13).
    const plus = item.command.id === "balance" && user?.balancePlus === true;
    return (
      <Row
        active={active}
        icon={<Icon className={plus ? "size-4 text-gold-mark" : "size-4"} />}
        meta={item.gate ? <GateChip /> : plus ? <PlusMark /> : undefined}
      >
        <CommandName name={item.command.name} query={item.query} />
        <span className="truncate text-ink-2">{item.command.title}</span>
      </Row>
    );
  }
  if (item.kind === "claim") {
    return (
      <Row active={active} icon={<ClaimIcon code={Boolean(activity?.code)} />}>
        <span className="shrink-0 text-ink-2">
          {activity?.timedDraw ? "报名" : "领取"}
        </span>
        <span className="truncate font-medium text-ink">
          {activity?.title ?? "本红包"}
        </span>
      </Row>
    );
  }
  if (item.kind === "verify") {
    return (
      <Row active={active} icon={<KeyRound className="size-4 text-accent" />}>
        <span className="shrink-0 text-ink-2">验证</span>
        <span className="truncate font-medium text-ink">
          「{activity?.title ?? "本红包"}」
        </span>
        <span className="shrink-0 text-ink-2">的口令</span>
        <PasswordCount length={item.length} />
      </Row>
    );
  }
  if (item.kind === "scope") {
    if (item.purpose === "verify")
      return (
        <Row
          active={active}
          icon={<KeyRound className="size-4 text-accent" />}
          meta={
            <span className="shrink-0 text-xs text-ink-3">
              {item.hidden} 个未解出
            </span>
          }
        >
          <span className="shrink-0 text-ink-2">验证</span>
          <span className="truncate font-medium text-ink">
            「{activity?.title ?? "本红包"}」
          </span>
          <span className="shrink-0 text-ink-2">的其他口令</span>
        </Row>
      );
    return (
      <Row
        active={active}
        icon={
          <ClaimIcon
            code={item.purpose === "code" || Boolean(activity?.code)}
          />
        }
      >
        <span className="shrink-0 text-ink-2">
          {activity?.timedDraw ? "报名" : "领取"}
        </span>
        <span className="truncate font-medium text-ink">
          {activity?.title ?? "本红包"}
        </span>
      </Row>
    );
  }
  if (item.kind === "discover")
    return (
      <Row active={active} icon={<Search className="size-4" />}>
        {/* As 一键优化's: the whole 口令, on its own line when narrow. */}
        <span className="grid min-w-0 flex-1 gap-0.5 @wide/window:block">
          <span className="text-ink-2">
            {item.scoped ? "在全部红包中查找" : "查找口令"}
          </span>{" "}
          <span className="font-mono text-sm text-ink [overflow-wrap:anywhere]">
            {item.password}
          </span>
        </span>
        <PasswordCount length={item.length} />
      </Row>
    );
  if (item.kind === "jump") {
    return (
      <Row active={active} icon={<ArrowRight className="size-4" />}>
        <span className="shrink-0 text-ink-2">打开</span>
        <span className="truncate font-medium text-ink">
          {activity?.title ?? `红包 ${item.activityId.slice(0, 8)}`}
        </span>
      </Row>
    );
  }
  if (item.kind === "topic")
    return (
      <Row active={active} icon={<MessagesSquare className="size-4" />}>
        <span className="shrink-0 text-ink-2">查看帖子里的红包</span>
        <span className="truncate text-ink">
          帖子 {item.scheme.topicId} · {item.scheme.postNumber} 楼
        </span>
      </Row>
    );
  return (
    <Row
      active={active}
      icon={<History className="size-4" />}
      meta={
        <span className="flex shrink-0 items-center gap-2 text-xs text-ink-3">
          <span className="flex items-center gap-1.5">
            <span
              className={`size-1.5 rounded-full ${statusTone[item.entry.status]}`}
            />
            {statusText[item.entry.status]}
          </span>
          <span className="hidden @wide/window:inline">
            {relativeTime(item.entry.at)}
          </span>
        </span>
      }
    >
      <span className="truncate font-mono text-sm text-ink">
        {item.entry.password}
      </span>
    </Row>
  );
}

/** The glass list under the omnibox, shared by the start page and the expanded box. */
export function SuggestionPanel({
  id,
  items,
  active,
  onHover,
  onRun,
  message,
  footer,
  empty,
  body,
  maxHeight,
}: {
  id: string;
  items: Suggestion[];
  active: number;
  onHover: (index: number) => void;
  onRun: (item: Suggestion) => void;
  message?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  /** In place of rows (代码判定's own record, 02 §4). */
  body?: ReactNode;
  maxHeight?: number;
}) {
  const reduced = useReducedMotionPref();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const timing = { duration: reduced ? 0 : 0.18, delay: reduced ? 0 : 0.06 };
  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: 0.1 } },
    transition: timing,
  };
  return (
    <motion.div
      initial={{ y: reduced ? 0 : -6 }}
      animate={{ y: 0 }}
      exit={{ y: reduced ? 0 : -6, transition: { duration: 0.1 } }}
      transition={timing}
      className="absolute inset-x-0 top-full mt-2"
    >
      <SquirclePlate className="pop-plate" radius={radius.pop} {...fade} />
      <Squircle radius={radius.pop}>
        <motion.div className="glass-pop relative overflow-hidden" {...fade}>
          <div className="relative overflow-y-auto p-2" style={{ maxHeight }}>
            {message && <div className="px-2.5 pt-2 pb-2.5">{message}</div>}
            {items.length > 0 ? (
              <div
                ref={listRef}
                id={id}
                role="listbox"
                aria-label="可执行的操作"
              >
                {items.map((item, index) => (
                  // Focus stays in the textarea (aria-activedescendant); arrow
                  // keys and Enter are handled there, the mouse is handled here.
                  <Squircle key={item.key} radius={radius.row}>
                    <div
                      id={`${id}-${index}`}
                      role="option"
                      aria-selected={index === active}
                      tabIndex={-1}
                      data-index={index}
                      onMouseDown={(event) => event.preventDefault()}
                      // Only a pointer that moves picks a row: a row growing
                      // under a still one (a long 口令 wrapping) must not
                      // take the choice from the row it was on.
                      onMouseMove={(event) => {
                        if (event.movementX !== 0 || event.movementY !== 0)
                          onHover(index);
                      }}
                      onClick={() => onRun(item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onRun(item);
                      }}
                      className={`flex min-h-12 w-full cursor-pointer items-center gap-3 px-2.5 py-1.5 text-left text-base transition-colors ${
                        index === active ? "bg-fill-2" : ""
                      }`}
                    >
                      <SuggestionContent
                        item={item}
                        active={index === active}
                      />
                    </div>
                  </Squircle>
                ))}
              </div>
            ) : (
              !message && empty
            )}
            {body}
            {footer}
          </div>
        </motion.div>
      </Squircle>
    </motion.div>
  );
}
