import type { PublicUserProfile } from "@hb/contracts";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { SafeMarkdown } from "../activities/markdown";
import { UserIdentity } from "../user-identity";
import { AnimatedDisclosure } from "./animated-disclosure";

const titles = { before: "活动说明", after: "奖励附言", ended: "结束说明" };
export function ActivityNoteSection({
  stage,
  content,
  author,
  defaultExpanded = true,
}: {
  stage: keyof typeof titles;
  content: string;
  author: PublicUserProfile;
  defaultExpanded?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const layoutAnimation = reducedMotion ? undefined : ("position" as const);
  const layoutTransition = reducedMotion
    ? undefined
    : { layout: { duration: 0.22, ease: "easeOut" as const } };
  if (!content?.trim()) return null;
  return (
    <motion.section
      className="activity-note-section"
      data-note-region={stage}
      aria-label={titles[stage]}
      layout={layoutAnimation}
      transition={layoutTransition}
    >
      <AnimatedDisclosure
        className="activity-note-disclosure"
        restorationKey={`note:${stage}`}
        defaultExpanded={defaultExpanded}
        summary={
          <>
            <span>{titles[stage]}</span>
            <ChevronDown size={15} aria-hidden="true" />
          </>
        }
      >
        <SafeMarkdown stage={stage}>{content}</SafeMarkdown>
        <div className="activity-note-signature">
          <span>来自</span>
          <div
            className="activity-note-signature-author"
            title={author.displayName || author.username}
          >
            <UserIdentity profile={author} />
          </div>
        </div>
      </AnimatedDisclosure>
    </motion.section>
  );
}
export function ActivityNotes({
  before,
  after,
  author,
}: {
  before: string;
  after?: string;
  author: PublicUserProfile;
}) {
  const hasAfter = Boolean(after?.trim());
  const reducedMotion = useReducedMotion();
  const layoutAnimation = reducedMotion ? undefined : ("position" as const);
  const layoutTransition = reducedMotion
    ? undefined
    : { layout: { duration: 0.22, ease: "easeOut" as const } };
  return (
    <motion.div
      className="activity-notes"
      layout={layoutAnimation}
      transition={layoutTransition}
    >
      {hasAfter && after && (
        <ActivityNoteSection stage="after" content={after} author={author} />
      )}
      <ActivityNoteSection
        stage="before"
        content={before}
        author={author}
        defaultExpanded={!hasAfter}
      />
    </motion.div>
  );
}
