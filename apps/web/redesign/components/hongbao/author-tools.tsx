import { useNavigate } from "@tanstack/react-router";
import { BarChart3, Eye, PenLine, ReceiptText } from "lucide-react";
import type { FixtureActivity } from "../../fixtures/activities";
import { activityCode, type SenderPage } from "../../lib/activity-route";
import { Callout } from "../page/page";
import { Button } from "../ui/button";
import { radius, Squircle } from "../ui/squircle";

/**
 * On the sender's own 红包: the way to its 📝 / 📊 / 🧾 pages (production's
 * 管理活动 menu), and for a 草稿 the note that this is only a preview.
 */
export function AuthorTools({ activity }: { activity: FixtureActivity }) {
  const navigate = useNavigate();
  const draft = Boolean(activity.draft);
  const go = (page: SenderPage) =>
    void navigate({
      to:
        page === "edit"
          ? "/🧧/$code/📝"
          : page === "stats"
            ? "/🧧/$code/📊"
            : "/🧧/$code/🧾",
      params: { code: activityCode(activity.id) },
    });
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
      <Squircle radius={radius.card}>
        <div className="panel flex flex-wrap items-center justify-between gap-1 p-1.5">
          {/* The hint above already says so on a narrow window. */}
          <span className="hidden px-2.5 text-sm text-ink-3 @wide/window:inline">
            你发的红包
          </span>
          <span className="flex flex-1 flex-wrap justify-around gap-1 @wide/window:flex-none @wide/window:justify-end">
            <Button
              size="sm"
              variant={draft ? "primary" : "ghost"}
              onClick={() => go("edit")}
            >
              <PenLine />
              {draft ? "继续编辑" : "编辑"}
            </Button>
            {!draft && activity.statistics && (
              <Button size="sm" variant="ghost" onClick={() => go("stats")}>
                <BarChart3 />
                尝试统计
              </Button>
            )}
            {!draft && (
              <Button size="sm" variant="ghost" onClick={() => go("payments")}>
                <ReceiptText />
                付款记录
              </Button>
            )}
          </span>
        </div>
      </Squircle>
    </section>
  );
}
