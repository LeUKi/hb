import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { type ReactNode, useId, useRef, useState } from "react";

export function AnimatedRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={reduced ? false : { height: 0, opacity: 0 }}
      animate={{
        height: "auto",
        opacity: 1,
        transitionEnd: { overflow: "visible" },
      }}
      exit={{ height: 0, opacity: 0, overflow: "clip" }}
      transition={{ duration: reduced ? 0 : 0.2, ease: "easeInOut" }}
      style={{ minWidth: 0, overflow: "clip" }}
    >
      {children}
    </motion.div>
  );
}

/** Retain native summary semantics while letting the content finish closing. */
export function AnimatedDisclosure({
  summary,
  children,
  className,
  defaultExpanded = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  defaultExpanded?: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [retaining, setRetaining] = useState(false);
  const latest = useRef(defaultExpanded);
  const trigger = useRef<HTMLElement>(null);
  return (
    <details className={className} open={expanded || retaining}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native keyboard-operable disclosure control, not a static element. */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: expose the real expanded state while details stays open for the closing animation. */}
      <summary
        ref={trigger}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={(event) => {
          event.preventDefault();
          const next = !expanded;
          latest.current = next;
          setRetaining(true);
          setExpanded(next);
          if (!next) trigger.current?.focus({ preventScroll: true });
        }}
      >
        {summary}
      </summary>
      <AnimatePresence
        initial={false}
        onExitComplete={() => {
          if (!latest.current) setRetaining(false);
        }}
      >
        {expanded && (
          <AnimatedRegion key="content">
            <div id={id}>{children}</div>
          </AnimatedRegion>
        )}
      </AnimatePresence>
    </details>
  );
}
