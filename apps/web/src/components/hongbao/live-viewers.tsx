import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { liveViewersAtom } from "../../lib/live-state";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { buttonHeight, buttonRadius, useButtonShape } from "../ui/button";
import { MorphLabel, RollingNumber } from "../ui/morph-label";
import { SquircleFill } from "../ui/squircle";

/**
 * 「N 人在看」, pinned top left as 分享 is top right, while the 红包 runs:
 * how many people have its page open right now, each once however many
 * tabs (api: activities/live.ts). Only signed-in viewers are on the live
 * channel, so only they are counted, and only they see it. It goes while
 * the line is down, and comes back with the next count.
 */
export function LiveViewers({
  activityId,
  running,
}: {
  activityId: string;
  running: boolean;
}) {
  const viewers = useAtomValue(liveViewersAtom);
  const reduced = useReducedMotionPref();
  const shape = useButtonShape(buttonRadius.sm, buttonHeight.sm);
  const count = running && viewers?.id === activityId ? viewers.count : null;
  return (
    <div
      className="pointer-events-none sticky top-[calc(var(--bar-h)+0.75rem)] z-20 h-0"
      data-hb-part="viewers"
    >
      <AnimatePresence initial={false}>
        {count !== null && (
          <motion.div
            key="viewers"
            className="absolute top-0 left-3 @wide/window:left-5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.2, ease }}
          >
            {/* The 分享 button's glass, but not a button: nothing to press. */}
            <span
              className="btn btn-secondary h-9 px-3.5 text-sm"
              style={shape}
            >
              <SquircleFill radius={buttonRadius.sm} />
              <span className="hb-live-dot" aria-hidden="true" />
              <MorphLabel>
                <span>
                  <RollingNumber value={count} /> 人在看
                </span>
              </MorphLabel>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
