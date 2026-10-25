import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  fuzzyLabels,
  type HongbaoActivity,
  type PublicView,
  type RosterRow,
} from "../../lib/hongbao";
import { useChallengers } from "../../lib/judge";
import { liveJudgedAtom } from "../../lib/live-state";
import { clockLabel } from "../../lib/roster-time";
import { useQueryLazyList } from "../page/lazy-list";
import { readFailed } from "../page/page-state";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Segmented } from "../ui/field";
import { Swap } from "../ui/reveal";
import { DrawProofDialog, DrawProofLine } from "./draw-proof";
import { RevealToggle } from "./password-text";
import {
  ChallengerList,
  RosterHeader,
  type RosterKind,
  RosterList,
  RosterRetry,
  RosterSkeleton,
  type RowDetail,
} from "./roster";
import type { HongbaoData } from "./use-hongbao";
import { type HongbaoPageData, useHongbaoPageData } from "./use-hongbao-data";

/** The context a screenshot needs: how much was taken, and when it opened. */
function metaLine(activity: HongbaoActivity, view: PublicView) {
  const parts: string[] = [];
  const { draw, quantity } = view;
  if (draw) {
    if (draw.registered === null) parts.push("名额不公开");
    else parts.push(`报名 ${draw.registered} 人`, `抽 ${activity.shares} 人`);
  } else if (quantity.kind === "fuzzy") {
    parts.push(
      quantity.level === "empty"
        ? "已领完"
        : `余量${fuzzyLabels[quantity.level]}`,
    );
  } else {
    parts.push(`已领 ${quantity.taken} / ${quantity.total} 份`);
  }
  if (!(activity.mode === "fixed" && quantity.kind === "fuzzy"))
    parts.push(`${activity.totalAmount} LDC`);
  parts.push(`${clockLabel(view.openedAt)} 开放`);
  return parts.join(" · ");
}

/** How many people a list holds, as the public counts say (none if fuzzy). */
function totalOf(view: PublicView, kind: RosterKind) {
  if (view.quantity.kind === "fuzzy") return null;
  if (kind === "claims") return view.quantity.taken;
  if (kind === "winners") return view.draw?.winners ?? null;
  return view.draw?.registered ?? null;
}

function RosterBody({
  activityId,
  onClose,
}: {
  activityId: string;
  onClose: () => void;
}) {
  const page = useHongbaoPageData(activityId);
  if (!page.data)
    return (
      <p role="status" className="px-6 py-10 text-center text-sm text-ink-3">
        正在读取…
      </p>
    );
  return <RosterContent data={page.data} page={page} onClose={onClose} />;
}

function RosterContent({
  data,
  page,
  onClose,
}: {
  data: HongbaoData;
  page: HongbaoPageData;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { activity, view, roster } = data;
  const [tab, setTab] = useState<"winners" | "registrations">("winners");
  // 代码判定's 参与名单: 领到 (the claims) or 挑战 (everyone judged), 05 §7.
  const code = activity.participation === "code";
  const [codeTab, setCodeTab] = useState<"claims" | "challengers">("claims");
  const challengers = useChallengers(activity.id, code);
  // A new judgment (已判定 moved, read or pushed): read it again.
  const pushed = useAtomValue(liveJudgedAtom);
  const judged = Math.max(
    activity.judge?.judged ?? 0,
    pushed?.id === activity.id ? pushed.count : 0,
  );
  const refetchChallengers = challengers.refetch;
  const [seenJudged, setSeenJudged] = useState(judged);
  useEffect(() => {
    if (!code || judged === seenJudged) return;
    setSeenJudged(judged);
    void refetchChallengers();
  }, [code, judged, seenJudged, refetchChallengers]);
  const challenging = code && codeTab === "challengers";
  // The 口令 on the sender's rows: hidden while it runs, until asked here.
  const [passwordsRevealed, setPasswordsRevealed] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  // 开奖证明: a draw's round, or a 拼手气's sealed queue.
  const proof = view.drawProof;
  const proofDone =
    proof?.kind === "draw"
      ? view.draw?.state === "completed" || view.draw?.state === "empty"
      : view.ended;
  const proofPeople =
    proof?.kind === "draw"
      ? (view.draw?.registered ?? null)
      : view.quantity.kind === "exact"
        ? view.quantity.taken
        : null;
  const fuzzy = view.quantity.kind === "fuzzy";
  const kind: RosterKind =
    roster.kind === "claims"
      ? "claims"
      : roster.kind === "draw" && tab === "winners"
        ? "winners"
        : "registrations";
  const rows =
    roster.kind === "draw"
      ? kind === "winners"
        ? roster.winners
        : roster.registrations
      : roster.rows;
  const source = challenging
    ? challengers
    : kind === "registrations"
      ? page.rosterLists.registrations.query
      : page.rosterLists.claims.query;
  const pending =
    source.data !== undefined ? null : readFailed(source) ? "error" : "loading";
  const list = useQueryLazyList({
    hasNextPage: source.hasNextPage,
    isFetchingNextPage: source.isFetchingNextPage,
    isFetchNextPageError: source.isFetchNextPageError,
    fetchNextPage: source.fetchNextPage,
    pageCount: source.data?.pages.length ?? 0,
  });
  const title = code
    ? "参与名单"
    : kind === "claims"
      ? "领取名单"
      : kind === "winners"
        ? "中奖名单"
        : "报名名单";
  const total = totalOf(view, kind);
  const challengerTotal = challengers.data?.pages[0]?.total;
  const author = activity.author.displayName;
  // The sender also sees, per row, the 口令 used and the payment (the author
  // roster endpoints return both; only for the sender's own 红包).
  const detailOf = (row: RosterRow): RowDetail | null => {
    const payment = row.payment
      ? { id: row.payment.id, state: row.payment.status }
      : null;
    // A 🐟额红包's claims and prizes went into 🐟额 (balance-design §14).
    const fish = activity.fish && kind !== "registrations";
    if (!row.password && !payment && !fish && !row.judge) return null;
    return {
      password: row.password ?? null,
      payment,
      fish,
      ...(row.judge ? { judge: row.judge } : {}),
    };
  };
  const openPayment = (paymentId: string) =>
    void navigate({
      to: "/payments/$paymentId",
      params: { paymentId },
      // Leaves the dialog's history entry behind, as closing would.
      replace: true,
    });

  return (
    <>
      <header className="grid gap-1 px-5 pt-4 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="roster-title" className="text-lg font-semibold text-ink">
            {title}
            {code || total === null ? "" : ` · ${total} 人`}
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="-mr-2 shrink-0"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
          <Avatar name={author} src={activity.author.avatarUrl} size={18} />
          <span className="truncate">
            {author}的红包 · {activity.title}
          </span>
        </p>
        <p className="text-xs text-ink-3">{metaLine(activity, view)}</p>
        {proof && (
          <DrawProofLine
            proof={proof}
            done={proofDone}
            onOpen={() => setProofOpen(true)}
          />
        )}
        {data.author && (
          <p className="flex items-center justify-between gap-2 text-xs text-gold-ink">
            <span>
              你发的红包：每行多一行
              {activity.participation === "password"
                ? "口令和"
                : activity.participation === "code"
                  ? "输入和"
                  : ""}
              {activity.fish ? "到账状态" : "付款状态"}
              ，只有你能看到。
            </span>
            {/* 代码判定's inputs show as typed (05 §3); 口令 hide until asked. */}
            {activity.participation === "password" && !view.ended && (
              <RevealToggle
                what="名单里的口令"
                shown={passwordsRevealed}
                onToggle={() => setPasswordsRevealed((value) => !value)}
                className="-my-2 -mr-2 shrink-0 text-gold-ink"
              />
            )}
          </p>
        )}
      </header>
      {code && (
        <div className="mx-5 mb-3 grid">
          <Segmented
            label="名单"
            size="sm"
            stretch
            value={codeTab}
            onChange={setCodeTab}
            options={[
              {
                value: "claims",
                label: "领到",
                count: total ?? undefined,
              },
              {
                value: "challengers",
                label: "挑战",
                count: challengerTotal,
              },
            ]}
          />
        </div>
      )}
      {roster.kind === "draw" && (
        <div className="mx-5 mb-3 grid">
          <Segmented
            label="名单"
            size="sm"
            stretch
            value={tab}
            onChange={setTab}
            options={[
              {
                value: "winners",
                label: "中奖名单",
                count: totalOf(view, "winners") ?? undefined,
              },
              {
                value: "registrations",
                label: "报名名单",
                count: totalOf(view, "registrations") ?? undefined,
              },
            ]}
          />
        </div>
      )}
      {!challenging && <RosterHeader kind={kind} />}
      {/* The list's own scroller: its end row is watched in it. */}
      <div className="view-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* Bars until the first batch is in (not 还没有人领取), and each
            tab's list fades in over the other's. */}
        <Swap id={pending ?? `rows:${challenging ? "challengers" : kind}`}>
          {pending === "loading" ? (
            <RosterSkeleton />
          ) : pending === "error" ? (
            <RosterRetry onRetry={() => void source.refetch()} />
          ) : challenging ? (
            <ChallengerList
              items={(challengers.data?.pages ?? []).flatMap(
                (one) => one.items,
              )}
              list={list}
              viewer={page.identity.user?.username ?? null}
            />
          ) : (
            <RosterList
              rows={rows}
              list={list}
              kind={kind}
              openedAt={view.openedAt}
              done={total === null || fuzzy ? "已全部加载" : `共 ${total} 人`}
              detailOf={data.author ? detailOf : undefined}
              passwordsShown={view.ended || code || passwordsRevealed}
              onPayment={openPayment}
            />
          )}
        </Swap>
      </div>
      {proof && (
        <DrawProofDialog
          open={proofOpen}
          onClose={() => setProofOpen(false)}
          activityId={activity.id}
          proof={proof}
          done={proofDone}
          people={proofPeople}
        />
      )}
    </>
  );
}

/**
 * 名单弹窗: the whole roster as a compact table, with the 红包 named at the
 * top so a screenshot explains itself. Focus returns to the roster entry.
 */
export function RosterDialog() {
  return (
    <PanelDialog
      panel="roster"
      triggerId="roster-entry"
      labelledBy="roster-title"
    >
      {(activityId, close) => (
        <RosterBody activityId={activityId} onClose={close} />
      )}
    </PanelDialog>
  );
}
