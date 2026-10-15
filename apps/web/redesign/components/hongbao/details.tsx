import type { FixtureActivity } from "../../fixtures/activities";
import { Avatar } from "../ui/avatar";

/** 说明 / 结束说明: the sender's words, signed. */
export function InfoNote({
  title,
  text,
  activity,
  part,
}: {
  title: string;
  text: string;
  activity: FixtureActivity;
  part: string;
}) {
  return (
    <section className="grid gap-2" data-hb-part={part}>
      <h2 className="text-sm font-medium text-ink-3">{title}</h2>
      <p className="text-base text-ink">{text}</p>
      <p className="flex items-center gap-1.5 text-xs text-ink-3">
        来自
        <Avatar name={activity.author.displayName} size={18} />
        {activity.author.displayName}
      </p>
    </section>
  );
}
