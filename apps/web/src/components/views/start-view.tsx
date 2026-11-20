import { atom, useAtomValue, useSetAtom } from "jotai";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { useBootDone } from "../../lib/boot";
import { brand } from "../../lib/brand";
import { cn } from "../../lib/cn";
import { commandById, commands, isVisible, roleOf } from "../../lib/commands";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { useRecentInputs } from "../../lib/recent-inputs";
import { useSessionUser } from "../../lib/session";
import { ClearRecentDialog } from "../omnibox/clear-recent";
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
import { Button } from "../ui/button";
import { IconTile } from "../ui/icon-tile";
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      {/* Level with the first line of chips (34px). */}
      <span className="flex h-[34px] w-14 shrink-0 items-center whitespace-nowrap text-xs text-ink-3">
        {label}
      </span>
      {/* More than fit wrap onto further lines; nothing scrolls sideways. */}
      <div className="flex min-w-0 flex-1 flex-wrap gap-2">{children}</div>
    </div>
  );
}

/**
 * How the cards lie (07 §1): up to four in one line on a wide window, then
 * three a line; two a line on a phone. 帮助中心, last, widens to fill its
 * line, so no line ends in a gap.
 */
const wideColumns = {
  2: "@wide/window:grid-cols-2",
  3: "@wide/window:grid-cols-3",
  4: "@wide/window:grid-cols-4",
} as const;
const wideSpan = {
  1: "@wide/window:col-span-1",
  2: "@wide/window:col-span-2",
  3: "@wide/window:col-span-3",
} as const;
function cardGrid(cards: number) {
  const columns = Math.min(4, Math.max(2, cards + 1 <= 4 ? cards + 1 : 3));
  const lastWide = columns - (cards % columns);
  const lastNarrow = 2 - (cards % 2);
  return {
    grid: wideColumns[columns as 2 | 3 | 4],
    last: cn(
      lastNarrow === 2 && "col-span-2",
      wideSpan[lastWide as 1 | 2 | 3] ?? "",
    ),
  };
}

/**
 * A 常用命令 as a card: its icon on its tile, its name, and what to
 * type for it, side by side (four to a line, two on a phone).
 */
function CommandCard({
  icon: Icon,
  title,
  typed,
  solid = false,
}: {
  icon: LucideIcon;
  title: string;
  /** What to type for it ("/history"). */
  typed: string;
  solid?: boolean;
}) {
  return (
    <>
      <IconTile icon={Icon} solid={solid} />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-sm font-medium text-ink">{title}</span>
        <span className="truncate font-mono text-xs text-ink-3">{typed}</span>
      </span>
    </>
  );
}

const cardClass =
  "choice flex min-w-0 items-center gap-2.5 px-3 py-2.5 text-left";

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
  const history = useRecentInputs(user?.id ?? null);
  const recent = history.entries;
  const [confirmClear, setConfirmClear] = useState(false);
  const setDraft = useSetAtom(startDraftAtom);
  const setMessage = useSetAtom(messageAtom);
  const held = useAtomValue(heldAtom);
  const role = roleOf(user);
  const quick = commands.filter(
    (command) => command.quick && isVisible(command, role),
  );
  const layout = cardGrid(quick.length);
  const help = commandById("help");

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
                {/* After the last one, level with the chips (07 §1). */}
                {/* Plain words, not a chip: never taken for one of them. */}
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-[34px] text-ink-3"
                  onClick={() => setConfirmClear(true)}
                >
                  清空
                </Button>
              </Row>
            </Reveal>
          )}
          <ClearRecentDialog
            open={confirmClear}
            count={recent.length}
            onClose={() => setConfirmClear(false)}
            onClear={() => {
              history.clear();
              setConfirmClear(false);
            }}
          />
          <Reveal index={1}>
            {/* The cards say what they are: no label, the whole line
                theirs (a screen reader still hears its name). */}
            <nav
              aria-label="常用命令"
              className={cn("grid grid-cols-2 gap-2", layout.grid)}
            >
              {quick.map((command) => (
                <Squircle key={command.id} radius={radius.choice}>
                  <CommandLink
                    command={command}
                    className={cardClass}
                    title={`${command.title} · /${command.name}`}
                  >
                    <CommandCard
                      icon={command.icon}
                      title={command.title}
                      typed={`/${command.name}`}
                    />
                  </CommandLink>
                </Squircle>
              ))}
              {/* 帮助中心 (docs/help-center-design.md §2.1), last and
                  widened, in gold: where to go when unsure. All commands
                  are still a / away in the 输入框. */}
              <Squircle radius={radius.choice}>
                <CommandLink
                  command={help}
                  className={cn(cardClass, "choice-gold", layout.last)}
                  title="帮助中心 · /help"
                >
                  <CommandCard
                    icon={help.icon}
                    title="帮助中心"
                    typed="/help"
                    solid
                  />
                </CommandLink>
              </Squircle>
            </nav>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
