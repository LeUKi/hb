import type { ManagedActivity } from "@hb/contracts";
import { CircleStop, Eye } from "lucide-react";
import { useRef, useState } from "react";
import {
  ActivityRequestError,
  refused,
  useActivityWrites,
  useManagedActivity,
} from "../../lib/activities";
import { sentRecordOf } from "../../lib/records";
import { type SessionUser, useIdentity } from "../../lib/session";
import { statusOf } from "../hongbao/hongbao-card";
import { HongbaoForm } from "../hongbao-form/hongbao-form";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Callout, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { HoverNote } from "../ui/hover-note";
import { Swap } from "../ui/reveal";
import { StatusChip } from "../ui/status-chip";

/**
 * 提前结束: only while it is running and nobody has claimed or signed up
 * (production's rule); otherwise the people already in would lose out. A
 * 代码判定红包 its code paused may end with claims in: claims wait anyway,
 * and the rest goes back (docs/programmable-hongbao-design.md §3).
 */
function EndEarly({
  activity,
  user,
  csrfToken,
  onEnded,
}: {
  activity: ManagedActivity;
  user: SessionUser;
  csrfToken: string;
  onEnded: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writes = useActivityWrites(user.id, csrfToken, activity.id);
  const busy = writes.end.isPending;
  const doneRef = useRef<HTMLDivElement>(null);
  const end = () => {
    setError(null);
    writes.end.mutate(
      { version: activity.version },
      {
        onSuccess: () => {
          setDone(true);
          setConfirming(false);
          onEnded();
        },
        onError: (failure) =>
          setError(
            failure instanceof ActivityRequestError && failure.status === 429
              ? "尝试过于频繁，请稍后再试。"
              : refused(failure)
                ? failure.message
                : "提前结束没有完成：网络或服务出了问题，红包还在进行。可以再试一次。",
          ),
      },
    );
  };
  return (
    <PageSection
      id="end-early"
      title="提前结束"
      description={
        done
          ? undefined
          : activity.judgePaused
            ? "红包的代码连续出错，已暂停领取，所以现在可以提前结束。已经领到的不受影响，剩下的退回你的🐟额。结束后不能重新开放。"
            : "还没有人领取或报名，所以现在可以提前结束。结束后不能再领取或报名，也不能重新开放。"
      }
    >
      {/* The panel turns into its outcome in place. */}
      <Swap id={done ? "done" : "panel"}>
        {done ? (
          <div ref={doneRef} tabIndex={-1} className="outline-none">
            <Callout tone="success" icon={CircleStop} title="红包已提前结束">
              不能再领取或报名。红包页上写着“已提前结束”。
            </Callout>
          </div>
        ) : (
          <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-sm text-ink-2">
              {activity.judgePaused
                ? "暂停后只能提前结束，或者等到截止时间。"
                : "一旦有人领取或报名，就只能等它领完或到时间。"}
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
      </Swap>
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
        onClosed={() => doneRef.current?.focus({ preventScroll: true })}
        busy={busy}
        title="提前结束这个红包？"
        text={`「${activity.title}」结束后不能再领取或报名，也不能重新开放。`}
        error={error}
        actions={
          <>
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
          </>
        }
      />
    </PageSection>
  );
}

/** /🧧/<码>/📝 编辑红包: the 发红包 steps on a saved 红包, all collapsed. */
export function EditView({ id }: { id: string }) {
  const { user, csrfToken } = useIdentity();
  if (!user || !csrfToken) return null;
  return <Edit id={id} user={user} csrfToken={csrfToken} />;
}

function Edit({
  id,
  user,
  csrfToken,
}: {
  id: string;
  user: SessionUser;
  csrfToken: string;
}) {
  const { leaveTo } = useOmniboxController();
  const query = useManagedActivity(user.id, id);
  const [endedHere, setEndedHere] = useState(false);
  const activity = query.data?.activity;
  return (
    <PageLoad load={queryLoad(query)}>
      {activity && (
        <EditPage
          activity={activity}
          user={user}
          csrfToken={csrfToken}
          endedHere={endedHere}
          onEnded={() => setEndedHere(true)}
          onOpen={() => void leaveTo({ to: "activity", id: activity.id })}
        />
      )}
    </PageLoad>
  );
}

function EditPage({
  activity,
  user,
  csrfToken,
  endedHere,
  onEnded,
  onOpen,
}: {
  activity: ManagedActivity;
  user: SessionUser;
  csrfToken: string;
  endedHere: boolean;
  onEnded: () => void;
  onOpen: () => void;
}) {
  const draft = activity.status === "draft";
  const { view } = sentRecordOf(activity, activity.author);
  const status = statusOf(view, {
    draft,
    archived: activity.status === "archived",
  });
  // Nobody in yet (production's rule): ending early takes nothing away.
  const canEnd =
    !draft &&
    !view.endReason &&
    ((activity.claimedCount === 0 &&
      (activity.draw?.registeredCount ?? 0) === 0) ||
      activity.judgePaused === true);
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
                draft
                  ? "开放前什么都能改；拿到链接的人能看到，还不能领。"
                  : "开放后还能改标题、关联帖子、加入红包广场、说明、数量展示和领取前人机验证。"
              }
            >
              <StatusChip tone={status.tone} dot>
                {status.text}
              </StatusChip>
            </HoverNote>
            <Button variant="ghost" size="sm" onClick={onOpen}>
              <Eye />
              {draft ? "预览红包页" : "查看红包页"}
            </Button>
          </>
        }
      />
      <HongbaoForm
        key={activity.id}
        activity={activity}
        user={user}
        csrfToken={csrfToken}
      />
      {(canEnd || endedHere) && (
        <EndEarly
          activity={activity}
          user={user}
          csrfToken={csrfToken}
          onEnded={onEnded}
        />
      )}
    </Page>
  );
}
