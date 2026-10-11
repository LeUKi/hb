import { ChevronDown } from "lucide-react";
import type { VisibleActivityNotes } from "../activity-notes";
import { ActivityNote } from "./activity-note";
import { AnimatedDisclosure } from "./animated-disclosure";
import { UserIdentity } from "./identity";
import "./activity-notes.css";

const titles = {
  before: "活动说明",
  after: "奖励附言",
  ended: "结束说明",
} as const;

export type ActivityNoteAuthor = {
  name: string;
  username: string;
  color?: string;
};

export function ActivityNoteSection({
  stage,
  content,
  author,
  defaultExpanded = true,
}: {
  stage: keyof VisibleActivityNotes;
  content: string;
  author: ActivityNoteAuthor;
  defaultExpanded?: boolean;
}) {
  return (
    <section
      className="activity-note-section"
      data-note-region={stage}
      aria-label={titles[stage]}
    >
      <AnimatedDisclosure
        className="activity-note-disclosure"
        defaultExpanded={defaultExpanded}
        summary={
          <>
            <span>{titles[stage]}</span>
            <ChevronDown size={15} aria-hidden="true" />
          </>
        }
      >
        <ActivityNote stage={stage}>{content}</ActivityNote>
        <div className="activity-note-signature">
          <span>来自</span>
          <div className="activity-note-signature-author" title={author.name}>
            <UserIdentity
              name={author.name}
              username={author.username}
              color={author.color}
            />
          </div>
        </div>
      </AnimatedDisclosure>
    </section>
  );
}

/** Receives authorized content only; it cannot reveal a locked stage. */
export function ActivityNotes({
  notes,
  author,
}: {
  notes: Pick<VisibleActivityNotes, "before" | "after">;
  author: ActivityNoteAuthor;
}) {
  if (!notes.before && !notes.after) return null;
  return (
    <div className="activity-notes">
      {notes.after && (
        <ActivityNoteSection
          stage="after"
          content={notes.after}
          author={author}
        />
      )}
      {notes.before && (
        <ActivityNoteSection
          stage="before"
          content={notes.before}
          author={author}
          defaultExpanded={!notes.after}
        />
      )}
    </div>
  );
}
