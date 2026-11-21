import type { ManagedActivity } from "@hb/contracts";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { revealsAtEnd } from "../../../../../kit/runtime/params.mjs";
import { useManagedActivity } from "../../lib/activities";
import { type SessionUser, useIdentity } from "../../lib/session";
import type { NewSearch } from "../../router";
import { useHongbaoPageData } from "../hongbao/use-hongbao-data";
import {
  copiedJudgeOf,
  copyFormOf,
  presetFormOf,
} from "../hongbao-form/form-state";
import { HongbaoForm } from "../hongbao-form/hongbao-form";
import { Page, PageHeader } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";

/** /new 发红包: four steps, one card open at a time. */
export function NewView() {
  const { user, csrfToken } = useIdentity();
  // Read as the page opens: 用它发红包 (docs/judge-square-design.md §6),
  // 也发一个 and 再发一个同样的 (docs/play-again-design.md §2).
  const asked = useSearch({
    strict: false,
    select: (search) => search as NewSearch,
  });
  const [start] = useState(asked);
  if (!user || !csrfToken) return null;
  if (start.from)
    return <CopyOf user={user} csrfToken={csrfToken} id={start.from} />;
  return (
    <Page>
      <PageHeader title="发红包" />
      <HongbaoForm
        user={user}
        csrfToken={csrfToken}
        startJudge={start.judge}
        preset={
          !start.judge && start.mode
            ? presetFormOf(start.mode, start.participation ?? "password")
            : undefined
        }
      />
    </Page>
  );
}

/**
 * 再发一个同样的 (play-again-design §2.2): one's own sent 红包, read as
 * its sender reads it, as the starting point; its 判定器 picked again.
 */
function CopyOf({
  user,
  csrfToken,
  id,
}: {
  user: SessionUser;
  csrfToken: string;
  id: string;
}) {
  const managed = useManagedActivity(user.id, id, true, false);
  const activity = managed.data?.activity;
  return (
    <PageLoad load={queryLoad(managed)}>
      <Page>
        <PageHeader title="发红包" />
        {activity &&
          (activity.config.money.mode === "code" ? (
            <CodedCopy activity={activity} user={user} csrfToken={csrfToken} />
          ) : (
            <CopyForm
              activity={activity}
              shown={new Set()}
              user={user}
              csrfToken={csrfToken}
            />
          ))}
      </Page>
    </PageLoad>
  );
}

/**
 * A 代码判定红包's copy keeps the params its page showed everyone from
 * opening (not those 结束后公开): read from its page first.
 */
function CodedCopy({
  activity,
  user,
  csrfToken,
}: {
  activity: ManagedActivity;
  user: SessionUser;
  csrfToken: string;
}) {
  const page = useHongbaoPageData(activity.id);
  // Its page's read under way, or failed: the sheen, or the error with 重试
  // (it once stayed blank for good after an error).
  if (!page.data && !page.missing)
    return <PageLoad load={page.load}>{null}</PageLoad>;
  const shown = new Set(
    (page.data?.activity.judge?.params ?? [])
      .filter(({ param }) => !revealsAtEnd(param))
      .map(({ param }) => param.key),
  );
  return (
    <CopyForm
      activity={activity}
      shown={shown}
      user={user}
      csrfToken={csrfToken}
    />
  );
}

function CopyForm({
  activity,
  shown,
  user,
  csrfToken,
}: {
  activity: ManagedActivity;
  shown: ReadonlySet<string>;
  user: SessionUser;
  csrfToken: string;
}) {
  // Taken once: later reads of the 红包 do not refill what was typed.
  const [start] = useState(() => ({
    form: copyFormOf(activity, shown),
    judge: copiedJudgeOf(activity),
  }));
  return (
    <HongbaoForm
      user={user}
      csrfToken={csrfToken}
      startJudge={start.judge ?? undefined}
      preset={start.form}
      copied
    />
  );
}
