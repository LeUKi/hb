import { atom, useAtomValue, useSetAtom } from "jotai";
import { type LucideIcon, SquareSlash } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useBootDone } from "../../lib/boot";
import { brand } from "../../lib/brand";
import { cn } from "../../lib/cn";
import {
  type CommandId,
  commands,
  isVisible,
  roleOf,
} from "../../lib/commands";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { useRecentInputs } from "../../lib/recent-inputs";
import { useSessionUser } from "../../lib/session";
import {
  messageAtom,
  omniboxMetrics,
  startDraftAtom,
  startHintElementAtom,
  startLinesAtom,
  unconfirmedAtom,
} from "../omnibox/state";
import { focusOmniboxInput } from "../omnibox/use-omnibox-controller";
import { CommandLink } from "../shell/command-link";
import { useSlot } from "../shell/slots";
import { useWindowInfo } from "../shell/window-info";
import { radius, Squircle } from "../ui/squircle";

const statusDot = {
  matched: "bg-success",
  unmatched: "bg-ink-3",
  unconfirmed: "bg-warning",
} as const;
const statusText = {
  matched: "已匹配",
  unmatched: "未匹配",
  unconfirmed: "未确认",
} as const;

/** Secondary start-page rows ease in; the omnibox slot itself never moves. */
function Reveal({
  index,
  className,
  children,
}: {
  index: number;
  className?: string;
  children: ReactNode;
}) {
  const bootDone = useBootDone();
  const reduced = useReducedMotionPref();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduced ? 0 : 8 }}
      animate={
        bootDone
          ? {
              opacity: 1,
              y: 0,
              transition: {
                duration: reduced ? 0 : 0.3,
                delay: reduced ? 0 : 0.12 + index * 0.05,
                ease,
              },
            }
          : { opacity: 0, y: reduced ? 0 : 8 }
      }
    >
      {children}
    </motion.div>
  );
}

function Row({
  label,
  cards = false,
  children,
}: {
  label: string;
  /** One line of cards: the label sits level with their middle. */
  cards?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex gap-3", cards ? "items-center" : "items-start")}>
      {/* Level with the first line of chips (34px). */}
      <span className="flex h-[34px] w-14 shrink-0 items-center whitespace-nowrap text-xs text-ink-3">
        {label}
      </span>
      {cards ? (
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-2">{children}</div>
      ) : (
        // More than fit wrap onto further lines; nothing scrolls sideways.
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">{children}</div>
      )}
    </div>
  );
}

/** Each 常用命令 its own colour, so the three read apart at a glance. */
const tints: Partial<Record<CommandId, string>> = {
  history: "bg-accent-soft text-accent-ink",
  square: "bg-gold-soft text-gold-ink",
};

/**
 * A 常用命令 as a card: its icon on a tinted tile, its name, and what to
 * type for it. Icon beside the words on a wide window, above them on a
 * phone, where three share the line.
 */
function CommandCard({
  icon: Icon,
  title,
  typed,
  tint = "bg-fill-2 text-ink-2",
  compact,
}: {
  icon: LucideIcon;
  title: string;
  /** What to type for it ("/history"). */
  typed: string;
  tint?: string;
  compact: boolean;
}) {
  return (
    <>
      <Squircle radius={10}>
        <span
          className={cn(
            "grid shrink-0 place-items-center",
            compact ? "size-8" : "size-9",
            tint,
          )}
        >
          <Icon className="size-[18px]" aria-hidden="true" />
        </span>
      </Squircle>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-sm font-medium text-ink">{title}</span>
        <span className="truncate font-mono text-xs text-ink-3">{typed}</span>
      </span>
    </>
  );
}

const cardClass = (compact: boolean) =>
  cn(
    "choice flex min-w-0 text-left",
    compact
      ? "flex-col items-start gap-2 p-3"
      : "items-center gap-2.5 px-3 py-2.5",
  );

/**
 * A lookup waiting on 再次确认 holds the box while its 口令 is typed there:
 * the recent chips would replace it. (Typed away, they are free again.)
 */
const heldAtom = atom((get) => {
  const lookup = get(unconfirmedAtom).lookup;
  return lookup !== null && lookup.password === get(startDraftAtom);
});

export function StartView() {
  const { compact } = useWindowInfo();
  const metrics = omniboxMetrics(compact);
  const startSlot = useSlot("start");
  const setHint = useSetAtom(startHintElementAtom);
  const lines = useAtomValue(startLinesAtom);
  const user = useSessionUser();
  const recent = useRecentInputs(user?.id ?? null).entries;
  const setDraft = useSetAtom(startDraftAtom);
  const setMessage = useSetAtom(messageAtom);
  const held = useAtomValue(heldAtom);
  const role = roleOf(user);
  const quick = commands.filter(
    (command) => command.quick && isVisible(command, role),
  );

  return (
    <div className="flex min-h-full flex-col items-center px-4 pb-6 @wide/window:px-8">
      {/* The page has no visible title (the brand is only in the tab's);
          a screen reader still gets one to land on. */}
      <h1 className="sr-only">{brand.name || brand.description}</h1>
      <div className="h-[clamp(2rem,16cqh,8rem)] shrink-0 @wide/window:h-[clamp(3rem,24cqh,16rem)]" />
      <div className="w-full max-w-[40rem]">
        <div
          ref={startSlot}
          aria-hidden="true"
          style={{ height: metrics.base + (lines - 1) * metrics.line }}
        />
        <div
          ref={(element) => {
            setHint(element);
            return () =>
              setHint((current) => (current === element ? null : current));
          }}
          className="min-h-9 px-1.5 pt-2.5"
        />
        {/* minmax(0,1fr): long chips wrap instead of widening the page. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 pt-1">
          {user && recent.length > 0 && (
            <Reveal index={0}>
              <Row label="最近输入">
                {recent.slice(0, 10).map((entry) => (
                  <Squircle key={entry.password} radius={radius.chip}>
                    <button
                      type="button"
                      disabled={held}
                      aria-label={`填入 ${entry.password}，${statusText[entry.status]}`}
                      title={statusText[entry.status]}
                      onClick={() => {
                        setDraft(entry.password);
                        setMessage(null);
                        focusOmniboxInput();
                      }}
                      className="chip font-mono"
                    >
                      <span
                        className={`size-1.5 rounded-full ${statusDot[entry.status]}`}
                      />
                      {entry.password}
                    </button>
                  </Squircle>
                ))}
              </Row>
            </Reveal>
          )}
          <Reveal index={1}>
            <Row label="常用命令" cards>
              {quick.map((command) => (
                <Squircle key={command.id} radius={radius.choice}>
                  <CommandLink
                    command={command}
                    className={cardClass(compact)}
                    title={`${command.title} · /${command.name}`}
                  >
                    <CommandCard
                      icon={command.icon}
                      title={command.title}
                      typed={`/${command.name}`}
                      tint={tints[command.id]}
                      compact={compact}
                    />
                  </CommandLink>
                </Squircle>
              ))}
              <Squircle radius={radius.choice}>
                <button
                  type="button"
                  className={cardClass(compact)}
                  title="全部命令 · /"
                  onClick={() => {
                    setDraft("/");
                    setMessage(null);
                    focusOmniboxInput();
                  }}
                >
                  <CommandCard
                    icon={SquareSlash}
                    title="全部命令"
                    typed="/"
                    compact={compact}
                  />
                </button>
              </Squircle>
            </Row>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
