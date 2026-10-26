import { useLocation, useMatches } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Layers } from "lucide-react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useActivityFacts } from "../../lib/activity-facts";
import {
  activityCode,
  activityIdFromCode,
  RED_PACKET,
  senderPages,
} from "../../lib/activity-route";
import { commandById } from "../../lib/commands";
import { useDrawDataName } from "../../lib/draw-check";
import { ease } from "../../lib/motion";
import { resultCountsAtom } from "../../lib/store";

function Slash() {
  return <span className="px-0.5 text-ink-3">/</span>;
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-3">
      {children}
    </span>
  );
}

/**
 * The 表情码 shrunk until all of it fits the room the bar leaves (on
 * phones, so all 14 show), never below 8px.
 */
function FitCode({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(15);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      element.style.fontSize = "15px";
      const natural = element.scrollWidth;
      const room = element.clientWidth;
      const next = Math.max(8, Math.min(15, (15 * room) / natural - 0.1));
      element.style.fontSize = `${next}px`;
      setSize(next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, []);
  return (
    <span
      ref={ref}
      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-emoji"
      style={{ fontSize: size }}
    >
      {text}
    </span>
  );
}

/** One address: a key that changes with the page, its spoken label, its look. */
export type Address = { key: string; label: string; node: ReactNode };

/**
 * What the docked bar shows: the address itself. Activities show their real
 * path /🧧/<emoji code>; pages show their "/" command.
 */
export function useAddress(compact: boolean): Address {
  const leaf = useMatches({ select: (matches) => matches[matches.length - 1] });
  const pathname = useLocation({ select: (location) => location.pathname });
  const code = (leaf?.params as { code?: string } | undefined)?.code;
  const activity = useActivityFacts(code ? activityIdFromCode(code) : null);
  const drawDataName = useDrawDataName(code ? activityIdFromCode(code) : null);
  const resultCounts = useAtomValue(resultCountsAtom);
  if (!leaf || leaf.routeId === "/")
    return { key: "start", label: "", node: null };
  const params = leaf.params as Record<string, string>;
  const missing = {
    key: `path:${pathname}`,
    label: pathname,
    node: <Muted>{pathname}</Muted>,
  };

  const senderPage = leaf.staticData.senderPage;
  if (leaf.routeId === "/🧧/$code" || senderPage) {
    const id = activityIdFromCode(params.code ?? "");
    if (!id) return missing;
    const page = senderPage ? senderPages[senderPage] : null;
    return {
      key: page ? `activity:${id}:${senderPage}` : `activity:${id}`,
      label: page
        ? `${page.title}「${activity?.title ?? "红包"}」`
        : activity
          ? `红包「${activity.title}」`
          : "红包",
      node: (
        <span
          className="flex min-w-0 flex-1 items-center text-ink"
          title={activity?.title}
        >
          {!compact && <Slash />}
          <span className="shrink-0 font-emoji">{RED_PACKET}</span>
          {compact ? <span className="w-1.5 shrink-0" /> : <Slash />}
          {/* A narrow bar shrinks the code until all 14 emoji fit. */}
          {compact ? (
            <FitCode text={activityCode(id)} />
          ) : (
            <span className="min-w-0 truncate font-emoji tracking-[0.04em]">
              {activityCode(id)}
            </span>
          )}
          {page && (
            <>
              <Slash />
              <span className="shrink-0 font-emoji">{page.emoji}</span>
              {!compact && (
                <span className="ml-2 shrink-0 font-sans text-sm text-ink-3">
                  {page.title}
                </span>
              )}
            </>
          )}
        </span>
      ),
    };
  }

  const subpage =
    leaf.routeId === "/🧧/$code/🎲" ? drawDataName : leaf.staticData.subpage;
  if (subpage) {
    return {
      key: `path:${pathname}`,
      label: `${pathname} ${subpage}`,
      node: (
        <span
          className="flex min-w-0 flex-1 items-baseline font-mono text-[15px] text-ink"
          title={subpage}
        >
          <span className="min-w-0 truncate">{pathname}</span>
          {!compact && (
            <span className="ml-2.5 shrink-0 font-sans text-sm text-ink-3">
              {subpage}
            </span>
          )}
        </span>
      ),
    };
  }

  const commandId = leaf.staticData.command;
  if (commandId) {
    const command = commandById(commandId);
    return {
      key: `command:${command.id}`,
      label: `/${command.name} ${command.title}`,
      node: (
        <span
          className="min-w-0 flex-1 truncate font-mono text-[15px] text-ink"
          title={command.title}
        >
          <span className="text-ink-3">/</span>
          {command.name}
          {!compact && (
            <span className="ml-2.5 font-sans text-sm text-ink-3">
              {command.title}
            </span>
          )}
        </span>
      ),
    };
  }

  if (leaf.routeId === "/🔑/$resultId") {
    const count = resultCounts[params.resultId ?? ""] ?? 0;
    const label = count > 0 ? `匹配到 ${count} 个红包` : "查找结果";
    return {
      key: `redeem:${params.resultId}`,
      label,
      node: (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-ink">
          <Layers className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </span>
      ),
    };
  }

  if (leaf.routeId === "/💬/$topicId/$postNumber") {
    const post = params.postNumber ?? "1";
    return {
      key: `topic:${params.topicId}:${post}`,
      label: `帖子 ${params.topicId} · ${post} 楼`,
      node: (
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink">
          <span className="text-ink-3">linux.do/t/topic/</span>
          {params.topicId}
          <Slash />
          {post}
        </span>
      ),
    };
  }

  return missing;
}

// A drum: the old address turns up and away, the new one turns up from
// below. Both faces sit on one cylinder (the transform origin is behind the
// text), so they stay a quarter turn apart for the whole roll.
const drum: Variants = {
  enter: (roll: boolean) =>
    roll ? { rotateX: -90, opacity: 0 } : { rotateX: 0, opacity: 1 },
  center: { rotateX: 0, opacity: 1 },
  exit: (roll: boolean) =>
    roll
      ? { rotateX: 90, opacity: 0 }
      : { opacity: 0, transition: { duration: 0 } },
};

/**
 * Rolls between addresses while the bar is showing one; `roll` is false when
 * the bar is only fading in (or motion is reduced), and the swap is instant.
 */
export function AddressRoller({
  address,
  roll,
  depth,
}: {
  address: Address;
  roll: boolean;
  /** Drum radius in px, about half the bar height. */
  depth: number;
}) {
  return (
    <span
      aria-hidden="true"
      // A far perspective, centred near the text start, keeps the left-aligned
      // address from skewing as it turns.
      className="relative min-w-0 flex-1 self-stretch overflow-hidden [perspective-origin:25%_50%] [perspective:1400px]"
    >
      <AnimatePresence initial={false} custom={roll}>
        <motion.span
          key={address.key}
          custom={roll}
          variants={drum}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{
            rotateX: { type: "spring", visualDuration: 0.42, bounce: 0.16 },
            opacity: { duration: 0.24, ease },
          }}
          style={{ originZ: -depth, backfaceVisibility: "hidden" }}
          className="absolute inset-0 flex items-center"
          data-morph="swap"
        >
          {address.node}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
