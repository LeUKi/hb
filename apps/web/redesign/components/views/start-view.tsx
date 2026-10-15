import { atom, useAtomValue, useSetAtom } from "jotai";
import { SquareSlash } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useBootDone } from "../../lib/boot";
import { brand } from "../../lib/brand";
import { commands, isVisible, roleOf } from "../../lib/commands";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { recentAtom, sessionAtom } from "../../lib/store";
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
  const user = useAtomValue(sessionAtom);
  const recent = useAtomValue(recentAtom);
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
            <Row label="常用命令">
              {quick.map((command) => (
                <Squircle key={command.id} radius={radius.chip}>
                  <CommandLink
                    command={command}
                    className="chip"
                    title={command.title}
                  >
                    <span className="font-mono">
                      <span className="text-ink-3">/</span>
                      {command.name}
                    </span>
                    <span className="text-ink-2">{command.title}</span>
                  </CommandLink>
                </Squircle>
              ))}
              <Squircle radius={radius.chip}>
                <button
                  type="button"
                  className="chip text-ink-2"
                  onClick={() => {
                    setDraft("/");
                    setMessage(null);
                    focusOmniboxInput();
                  }}
                >
                  <SquareSlash className="size-4" aria-hidden="true" />
                  全部命令
                </button>
              </Squircle>
            </Row>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
