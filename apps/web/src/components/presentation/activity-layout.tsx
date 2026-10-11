import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Envelope } from "./envelope";
import { SkeletonRows } from "./loading";

/** Animate natural content height without scaling text or nesting disclosure timelines. */
export function ActivityRegion({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "header";
}) {
  const root = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const node = root.current;
    const inner = content.current;
    if (!node || !inner) return;
    let previous: number | undefined;
    let stop: (() => void) | undefined;
    const measure = () => {
      const style = getComputedStyle(node);
      const next =
        inner.getBoundingClientRect().height +
        Number.parseFloat(style.paddingTop || "0") +
        Number.parseFloat(style.paddingBottom || "0") +
        Number.parseFloat(style.borderTopWidth || "0") +
        Number.parseFloat(style.borderBottomWidth || "0");
      if (previous !== undefined && Math.abs(previous - next) < 0.5) return;
      stop?.();
      const immediate =
        reduced ||
        previous === undefined ||
        Boolean(inner.querySelector('[data-disclosure-animating="true"]'));
      previous = next;
      if (immediate) {
        height.set(next);
        delete node.dataset.layoutSettling;
      } else {
        node.dataset.layoutSettling = "true";
        const animation = animate(height, next, {
          duration: 0.22,
          ease: "easeOut",
          onComplete: () => {
            delete node.dataset.layoutSettling;
          },
        });
        stop = () => animation.stop();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => {
      stop?.();
      observer.disconnect();
      delete node.dataset.layoutSettling;
    };
  }, [height, reduced]);
  const Element = as === "header" ? motion.header : motion.div;
  return (
    <Element
      ref={(node) => {
        root.current = node;
      }}
      className={className}
      style={{ height, minWidth: 0 }}
    >
      <div ref={content} className="activity-region-content">
        {children}
      </div>
    </Element>
  );
}

export function ActivityHeadingSkeleton() {
  return (
    <>
      <div className="activity-title-row" aria-hidden="true">
        <span className="compact-icon-button activity-back-button" />
        <span className="activity-heading-skeleton activity-heading-skeleton--title" />
      </div>
      <div className="activity-meta" aria-hidden="true">
        <span className="activity-heading-skeleton activity-heading-skeleton--meta" />
        <span className="activity-heading-skeleton activity-heading-skeleton--meta" />
        <span className="activity-heading-skeleton activity-heading-skeleton--meta-short" />
      </div>
    </>
  );
}

/** The code-split fallback uses the same geometry as the live activity shell. */
export function ActivityPageSkeleton() {
  return (
    <article className="activity-page" aria-busy="true">
      <ActivityRegion as="header" className="activity-heading">
        <ActivityHeadingSkeleton />
      </ActivityRegion>
      <section className="claim-layout">
        <div className="claim-art">
          <Envelope open={false} size="detail" reserveResultSpace />
        </div>
        <ActivityRegion className="claim-copy">
          <SkeletonRows />
        </ActivityRegion>
      </section>
      <div data-layout-region="password-panel">
        <section className="password-section" aria-label="活动口令">
          <SkeletonRows rows={2} />
        </section>
      </div>
      <span className="sr-only" role="status">
        正在读取活动…
      </span>
    </article>
  );
}
