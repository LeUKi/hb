import { Eye } from "lucide-react";
import type { FixtureActivity } from "../../fixtures/activities";
import { Callout, Panel } from "../page/page";
import { SenderLinks } from "./sender-links";

/**
 * On the sender's own 红包: the way to its 📝 / 📊 / 🧾 pages (production's
 * 管理活动 menu), and for a 草稿 the note that this is only a preview.
 */
export function AuthorTools({ activity }: { activity: FixtureActivity }) {
  const draft = Boolean(activity.draft);
  return (
    <section
      aria-label="管理这个红包"
      className="grid gap-2"
      data-hb-part="author"
    >
      {draft && (
        <Callout tone="warning" icon={Eye} title="草稿预览">
          只有你能看到这一页。开放后大家才能领取，链接也才能分享。
        </Callout>
      )}
      <Panel className="flex flex-wrap items-center justify-between gap-1 p-1.5">
        {/* The hint above already says so on a narrow window. */}
        <span className="hidden px-2.5 text-sm text-ink-3 @wide/window:inline">
          你发的红包
        </span>
        <span className="flex flex-1 flex-wrap justify-around gap-1 @wide/window:flex-none @wide/window:justify-end">
          <SenderLinks activity={activity} draftFirst />
        </span>
      </Panel>
    </section>
  );
}
