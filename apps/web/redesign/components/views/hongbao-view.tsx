import { useAtomValue } from "jotai";
import { type RefObject, useRef } from "react";
import {
  type FixtureActivity,
  visibleActivity,
} from "../../fixtures/activities";
import { publicOf } from "../../fixtures/hongbao";
import { cn } from "../../lib/cn";
import {
  identityFailedAtom,
  pageLoadSimAtom,
  sessionAtom,
} from "../../lib/store";
import { AuthorTools } from "../hongbao/author-tools";
import { InfoNote } from "../hongbao/details";
import { HongbaoHero, hongbaoSizes, sizeVars } from "../hongbao/hero";
import { HongbaoSkeleton } from "../hongbao/hongbao-skeleton";
import { PageActions } from "../hongbao/page-actions";
import { Sparks } from "../hongbao/parts";
import { PasswordSection } from "../hongbao/passwords";
import { useHongbao, useViewerContext } from "../hongbao/use-hongbao";
import { RefreshContext, RefreshNotice } from "../page/page";
import { LoadError, usePageLoad } from "../page/page-state";
import { useWindowInfo } from "../shell/window-info";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { IdentityFailedView, MessageView } from "./message-view";

export function HongbaoView({ id }: { id: string }) {
  const user = useAtomValue(sessionAtom);
  const identityFailed = useAtomValue(identityFailedAtom);
  const loadSim = useAtomValue(pageLoadSimAtom);
  const activity = visibleActivity(id, user?.username);
  // A 草稿 opens only for its sender, who cannot be told apart right now.
  if (!activity && identityFailed)
    return (
      <IdentityFailedView
        icon={HongbaoIcon}
        title="未找到红包"
        text="身份检查失败，请重新检查后继续。草稿只有发红包的人能打开。"
      />
    );
  if (!activity)
    return (
      <MessageView
        icon={HongbaoIcon}
        title="未找到红包"
        text="红包不存在，或链接已经失效。"
      />
    );
  // Re-keyed by the toolbar's 页面数据, so a change plays at once.
  return <HongbaoLoad key={loadSim} activity={activity} />;
}

/**
 * The page's data arriving (dev toolbar 页面数据, as for the other pages):
 * a skeleton of the cover, 读取失败 with 重试, or 刷新失败 above the 口令.
 * Not wrapped like PageLoad: the cover needs the article to be the
 * scroller's own child.
 */
function HongbaoLoad({ activity }: { activity: FixtureActivity }) {
  const article = useRef<HTMLElement>(null);
  const skeleton = useRef<number | null>(null);
  const context = useViewerContext(activity);
  // The skeleton has the cover's state: small once taken part in, faded
  // once ended (as the cover will be), so nothing jumps when it arrives.
  const small = Boolean(context.record);
  const ended = !small && publicOf(activity, context).ended;
  const load = usePageLoad(() =>
    article.current?.querySelector<HTMLElement>("h1[tabindex]"),
  );
  if (load.state === "loading")
    return (
      <HongbaoSkeleton
        focus={load.retried}
        small={small}
        ended={ended}
        onMeasure={(height) => {
          skeleton.current = height;
        }}
      />
    );
  if (load.state === "error") return <LoadError onRetry={load.retryLoad} />;
  return (
    <RefreshContext.Provider value={load.refresh}>
      <HongbaoPage
        activity={activity}
        articleRef={article}
        said={load.said}
        arriveFrom={load.loaded ? skeleton.current : null}
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
  activity,
  articleRef,
  said,
  arriveFrom,
}: {
  activity: FixtureActivity;
  articleRef: RefObject<HTMLElement | null>;
  /** "已刷新" after a 重试 that worked. */
  said: string;
  /**
   * Arrived after the skeleton: its cover height. The red goes on from it
   * and only what is on it fades in.
   */
  arriveFrom: number | null;
}) {
  const hongbao = useHongbao(activity);
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
      {/* A 草稿's link opens for nobody else, so there is nothing to share. */}
      {!activity.draft && (
        <PageActions
          activity={activity}
          passwords={passwords}
          isDraw={hongbao.isDraw}
        />
      )}
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
      />
      <div className="mx-auto grid w-full max-w-[36rem] gap-8 px-5 pt-8 @wide/window:px-8">
        <RefreshNotice />
        {hongbao.author && <AuthorTools activity={activity} />}
        {view.afterEndInfo && (
          <InfoNote
            title="结束说明"
            text={view.afterEndInfo}
            activity={activity}
            part="end-note"
          />
        )}
        <PasswordSection
          activityId={activity.id}
          passwords={passwords}
          onVerify={hongbao.openVerify}
        />
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
