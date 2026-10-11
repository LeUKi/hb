import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { type ReactNode, useId, useRef, useState } from "react";
import { useViewState } from "../../lib/navigation-state";

export function AnimatedRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const node = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return (
    <motion.div
      ref={node}
      onAnimationStart={() => {
        if (node.current) node.current.dataset.disclosureAnimating = "true";
      }}
      onAnimationComplete={() => {
        if (node.current) delete node.current.dataset.disclosureAnimating;
      }}
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
  restorationKey,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  defaultExpanded?: boolean;
  restorationKey?: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useViewState(
    `disclosure:${restorationKey ?? className ?? id}`,
    defaultExpanded,
  );
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
