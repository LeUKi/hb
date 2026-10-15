import { useAtomValue } from "jotai";
import { CircleStop, Eye } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { type FixtureActivity, findActivity } from "../../fixtures/activities";
import { publicOf } from "../../fixtures/hongbao";
import { senderPages } from "../../lib/activity-route";
import { documentTitle } from "../../lib/brand";
import { drawSimAtom, submitSimAtom } from "../../lib/store";
import { statusOf } from "../hongbao/hongbao-card";
import { HongbaoForm } from "../hongbao-form/hongbao-form";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Callout, Page, PageHeader, PageSection, Panel } from "../page/page";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { HoverNote } from "../ui/hover-note";
import { StatusChip } from "../ui/status-chip";

/**
 * 提前结束: only while it is running and nobody has claimed or signed up
 * (production's rule); otherwise the people already in would lose out.
 */
function EndEarly({
  activity,
  onEnded,
}: {
  activity: FixtureActivity;
  onEnded: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitSim = useAtomValue(submitSimAtom);
  // Dev toolbar 提交结果: the first try fails, trying again goes through.
  const failedOnce = useRef(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const doneRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const end = () => {
    setBusy(true);
    setError(null);
    timer.current = window.setTimeout(() => {
      setBusy(false);
      if (submitSim !== "ok" && !failedOnce.current) {
        failedOnce.current = true;
        setError(
          submitSim === "throttled"
            ? "尝试过于频繁，请稍后重试。"
            : "提前结束没有完成：网络或服务出了问题，红包还在进行。可以再试一次。",
        );
        return;
      }
      activity.closedAt = Date.now();
      setDone(true);
      setConfirming(false);
      onEnded();
    }, 600);
  };
  return (
    <PageSection
      title="提前结束"
      description={
        done
          ? undefined
          : "还没有人领取或报名，所以现在可以提前结束。结束后不能再领取或报名，也不能重新开放。"
      }
    >
      {done ? (
        <div ref={doneRef} tabIndex={-1} className="outline-none">
          <Callout tone="success" icon={CircleStop} title="红包已提前结束">
            不能再领取或报名。红包页上写着“已提前结束”。
          </Callout>
        </div>
      ) : (
        <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-ink-2">
            一旦有人领取或报名，就只能等它领完或到时间。
          </p>
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            <CircleStop />
            提前结束
          </Button>
        </Panel>
      )}
      <WindowDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
        onClosed={() => doneRef.current?.focus({ preventScroll: true })}
        labelledBy={titleId}
        busy={busy}
      >
        <div className="grid gap-4 p-5">
          <div className="grid gap-1">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              提前结束这个红包？
            </h2>
            <p className="text-sm text-ink-2">
              “{activity.title}”结束后不能再领取或报名，也不能重新开放。
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                setConfirming(false);
                setError(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) end();
              }}
            >
              {busy ? "正在结束…" : error ? "再试一次" : "提前结束"}
            </Button>
          </div>
        </div>
      </WindowDialog>
    </PageSection>
  );
}

/** /🧧/<码>/📝 编辑红包: the 发红包 steps on a saved 红包, all collapsed. */
export function EditView({ id }: { id: string }) {
  const drawSim = useAtomValue(drawSimAtom);
  const { leaveTo } = useOmniboxController();
  const [, rerender] = useState(0);
  const [endedHere, setEndedHere] = useState(false);
  const activity = findActivity(id);
  if (!activity) return null;
  const view = publicOf(activity, { solved: [], drawSim, now: Date.now() });
  const status = activity.draft
    ? { text: "草稿", tone: "neutral" as const }
    : statusOf(view);
  const canEnd =
    !activity.draft && !view.endReason && activity.entries.length === 0;
  // Stays on the page after ending, to say so (and to hold focus).
  return (
    <Page>
      <PageHeader
        eyebrow="编辑红包"
        title={activity.title}
        actions={
          <>
            {/* What can still change, on the tag that says why. */}
            <HoverNote
              note={
                activity.draft
                  ? "开放前只有你能看到，什么都能改。"
                  : "已开放：还能改标题、关联帖子、加入广场、说明和数量展示。"
              }
            >
              <StatusChip tone={status.tone} dot>
                {status.text}
              </StatusChip>
            </HoverNote>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void leaveTo({ to: "activity", id: activity.id })}
            >
              <Eye />
              {activity.draft ? "预览红包页" : "查看红包页"}
            </Button>
          </>
        }
      />
      <HongbaoForm
        key={activity.id}
        activity={activity}
        onSaved={() => {
          rerender((count) => count + 1);
          document.title = documentTitle(
            `${senderPages.edit.title} · ${activity.title}`,
          );
        }}
      />
      {(canEnd || endedHere) && (
        <EndEarly activity={activity} onEnded={() => setEndedHere(true)} />
      )}
    </Page>
  );
}
