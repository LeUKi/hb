import { useAtomValue } from "jotai";
import { activities } from "../../fixtures/activities";
import { isArchived, publicOf } from "../../fixtures/hongbao";
import { outcomeOf, useParticipations } from "../../lib/my-records";
import { drawSimAtom, sessionAtom } from "../../lib/store";
import { HongbaoCard } from "../hongbao/hongbao-card";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LazyRows } from "../page/lazy-list";
import { EmptyNote, Page, PageHeader } from "../page/page";
import { useSearchChoice } from "../shell/use-search-choice";
import { Segmented } from "../ui/field";

type Filter = "active" | "ended" | "all";

/**
 * /square 红包广场: the 红包 their senders chose to list (加入广场), newest
 * first, until 72 hours after they end (已归档, as production). Anyone can
 * browse, guests included; a card opens the 红包. Signed in, the cards say
 * which ones you took part in or sent.
 */
export function SquareView() {
  const drawSim = useAtomValue(drawSimAtom);
  const user = useAtomValue(sessionAtom);
  const joined = useParticipations();
  const { leaveTo } = useOmniboxController();
  const [filter, setFilter] = useSearchChoice<Filter>("filter", "active", [
    "active",
    "ended",
    "all",
  ]);
  const now = Date.now();
  const listed = activities
    .filter((activity) => activity.listed !== false && !activity.draft)
    .map((activity) => ({
      activity,
      view: publicOf(activity, { solved: [], drawSim, now }),
    }))
    .filter(({ activity, view }) => !isArchived(activity, view, now))
    .sort((a, b) => b.view.openedAt - a.view.openedAt);
  const mineOf = (id: string, author: string) => {
    if (user?.username === author)
      return { text: "你发的", tone: "gold" as const };
    const item = joined.find((entry) => entry.activity.id === id);
    if (!item) return null;
    const outcome = outcomeOf(item.mine);
    return { text: outcome.label, tone: outcome.tone };
  };
  // A draw being settled (开奖中) is still running: its result is to come.
  const settled = (item: (typeof listed)[number]) =>
    item.view.ended && item.view.endReason !== "settling";
  const running = listed.filter((item) => !settled(item));
  const over = listed.filter(settled);
  const shown =
    filter === "active" ? running : filter === "ended" ? over : listed;

  return (
    <Page width="wide">
      <PageHeader
        refreshable
        title="红包广场"
        description="发红包时选了“加入红包广场”的红包，按开放时间排列；结束 72 小时后不再列出。"
        actions={
          <Segmented
            label="筛选"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "active", label: "进行中", count: running.length },
              { value: "ended", label: "已结束", count: over.length },
              { value: "all", label: "全部", count: listed.length },
            ]}
          />
        }
      />
      {shown.length === 0 ? (
        <EmptyNote
          title={
            filter === "active"
              ? "现在没有进行中的红包"
              : filter === "ended"
                ? "没有已结束的红包"
                : "还没有红包"
          }
          text={
            filter === "ended"
              ? "结束不到 72 小时的红包会列在这里。"
              : "发红包时打开“加入红包广场”，红包就会出现在这里。"
          }
        />
      ) : (
        <LazyRows id="square" items={shown} done={`共 ${shown.length} 个`}>
          {(visible) => (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
              {visible.map(({ activity, view }) => (
                <li key={activity.id}>
                  <HongbaoCard
                    activity={activity}
                    view={view}
                    mine={mineOf(activity.id, activity.author.username)}
                    onOpen={() =>
                      void leaveTo({ to: "activity", id: activity.id })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </LazyRows>
      )}
    </Page>
  );
}
