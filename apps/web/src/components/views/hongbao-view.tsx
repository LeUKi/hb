import { type RefObject, useRef } from "react";
import { useCoverLook } from "../../lib/activity-facts";
import { cn } from "../../lib/cn";
import type { HongbaoActivity } from "../../lib/hongbao";
import { useActivityLive } from "../../lib/live";
import { AuthorTools } from "../hongbao/author-tools";
import { CodeEntry } from "../hongbao/code-section";
import { InfoNote } from "../hongbao/details";
import { HongbaoHero, hongbaoSizes, sizeVars } from "../hongbao/hero";
import { HongbaoSkeleton } from "../hongbao/hongbao-skeleton";
import { LiveViewers } from "../hongbao/live-viewers";
import { MyJudgments } from "../hongbao/my-judgments";
import { PageActions } from "../hongbao/page-actions";
import { Sparks } from "../hongbao/parts";
import { PasswordSection } from "../hongbao/passwords";
import { type HongbaoData, useHongbao } from "../hongbao/use-hongbao";
import { useHongbaoPageData } from "../hongbao/use-hongbao-data";
import { RefreshContext, RefreshNotice } from "../page/page";
import { LoadError, usePageLoad } from "../page/page-state";
import { useWindowInfo } from "../shell/window-info";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { IdentityFailedView, MessageView } from "./message-view";

export function HongbaoView({ id }: { id: string }) {
  const page = useHongbaoPageData(id);
  // A signed-in viewer has its changes pushed; guests poll.
  useActivityLive(id, page.identity.user?.id ?? null, page.liveWant);
  const article = useRef<HTMLElement>(null);
  const skeleton = useRef<number | null>(null);
  // What the skeleton drew: a 代码判定红包 drawn red fades into its lacquer.
  const look = useCoverLook(id);
  const skeletonCode = useRef(false);
  const load = usePageLoad(page.load, () =>
    article.current?.querySelector<HTMLElement>("h1[tabindex]"),
  );
  // A 草稿 opens only for its sender, who cannot be told apart right now.
  if (page.missing && page.identity.failed)
    return (
      <IdentityFailedView
        icon={HongbaoIcon}
        title="未找到红包"
        text="身份检查失败，请重新检查后继续。草稿只有红包作者能打开。"
      />
    );
  if (page.missing)
    return (
      <MessageView
        icon={HongbaoIcon}
        title="未找到红包"
        text="红包不存在，或链接已经失效。"
      />
    );
  if (load.state === "error") return <LoadError onRetry={load.retryLoad} />;
  if (!page.data)
    return (
      <HongbaoSkeleton
        focus={load.retried}
        small={false}
        // Red keeps its own skeleton; only a 代码判定红包 is drawn as known.
        ended={look?.code ? look.ended : false}
        code={look?.code ?? false}
        onMeasure={(height) => {
          skeleton.current = height;
          skeletonCode.current = look?.code ?? false;
        }}
      />
    );
  return (
    <RefreshContext.Provider value={load.refresh}>
      <HongbaoPage
        data={page.data}
        running={page.liveWant === "running"}
        articleRef={article}
        said={load.said}
        arriveFrom={load.loaded ? skeleton.current : null}
        fromRed={
          load.loaded && skeleton.current !== null && !skeletonCode.current
        }
      />
    </RefreshContext.Provider>
  );
}

/**
 * 「上红下数据」, with the data on the red: the cover carries the sender,
 * title, 说明 and 公开数据, the seal sits on its curved edge; below it on the
 * glass the hint or 我的结果, the 结束说明 and the 口令. Once taken part the
 * cover turns small when the page scrolls (see hero.tsx). The roster and a
 * long 说明 open in their own dialogs; 分享 stays pinned under the avatar.
 */
function HongbaoPage({
  data,
  running,
  articleRef,
  said,
  arriveFrom,
  fromRed,
}: {
  data: HongbaoData;
  /** Running, for a signed-in viewer: on the live channel. */
  running: boolean;
  articleRef: RefObject<HTMLElement | null>;
  /** "已刷新" after a 重试 that worked. */
  said: string;
  /**
   * Arrived after the skeleton: its cover height. The red goes on from it
   * and only what is on it fades in.
   */
  arriveFrom: number | null;
  /** The skeleton before it was red (a 代码判定红包 not known as one yet). */
  fromRed: boolean;
}) {
  const activity: HongbaoActivity = data.activity;
  const hongbao = useHongbao(data);
  const info = useWindowInfo();
  const sizes = hongbaoSizes(info);
  const { view, passwords, phase, fresh, reveal, reduced } = hongbao;
  const opened = phase === "open";
  const play = opened && fresh && !reduced;
  const won =
    hongbao.mine?.kind === "claimed" || hongbao.mine?.outcome === "won";
  const flecks = !reduced && won && (play || reveal);

  return (
    <article
      ref={articleRef}
      className={cn(
        // No scroll anchoring: as the cover shrinks the browser would pull
        // the page back to the top, which opens the cover again.
        "relative flex flex-col pb-14 [overflow-anchor:none]",
        // Taken part: always room to scroll the small cover back to big.
        opened ? "min-h-[calc(100cqh+var(--hb-reserve)+1rem)]" : "min-h-full",
        arriveFrom !== null && "hb-arrive",
      )}
      style={sizeVars(sizes)}
      data-phase={phase}
      data-cover-pinned={opened || undefined}
    >
      <PageActions />
      <LiveViewers activityId={activity.id} running={running} />
      <p className="sr-only" role="status">
        {hongbao.announcement}
      </p>
      <p className="sr-only" role="status">
        {said}
      </p>
      <HongbaoHero
        activity={activity}
        hongbao={hongbao}
        arriveFrom={arriveFrom}
        fromRed={fromRed}
      />
      <div
        className="mx-auto flex w-full max-w-[36rem] flex-col gap-8 px-5 pt-8 transition-[padding] duration-[420ms] ease-[cubic-bezier(0.2,0,0,1)] @wide/window:px-8"
        data-morph-children="move"
      >
        <RefreshNotice />
        {hongbao.author && (
          <AuthorTools activity={activity} ended={view.ended} />
        )}
        {view.afterEndInfo && (
          <InfoNote
            title="结束说明"
            text={view.afterEndInfo}
            activity={activity}
            part="end-note"
          />
        )}
        {/* What a claimant typed and what the code said (05 §3); its
            sender's too once they tried it (自领, docs/self-claim-design.md). */}
        {activity.judge && !activity.draft && (
          <MyJudgments activityId={activity.id} />
        )}
        {/* 代码判定红包 has its code where others have their 口令 (05 §9). */}
        {activity.judge ? (
          <CodeEntry published={Boolean(activity.judge.code)} />
        ) : (
          <PasswordSection
            activityId={activity.id}
            passwords={passwords}
            ended={view.ended}
            onVerify={hongbao.openVerify}
          />
        )}
      </div>
      {flecks && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[100cqh]">
          <Sparks
            delay={play ? hongbao.openDelay + 0.64 : 0.2}
            count={info.compact ? 22 : 34}
          />
        </div>
      )}
    </article>
  );
}
