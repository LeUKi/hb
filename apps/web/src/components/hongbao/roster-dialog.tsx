import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useChallengers } from "../../lib/judge";
import { liveJudgedAtom } from "../../lib/live-state";
import { PanelDialog } from "../shell/panel-dialog";
import { DrawProofDialog, DrawProofLine } from "./draw-proof";
import { RosterPanel } from "./roster-panel";
import type { HongbaoData } from "./use-hongbao";
import {
  type HongbaoPageData,
  ROSTER_FOLLOW_MS,
  useHongbaoPageData,
} from "./use-hongbao-data";

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

/** The 红包 page's own: 代码判定's 挑战, 开奖证明, a payment opened. */
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
  const { activity, view } = data;
  const code = activity.participation === "code";
  const challengers = useChallengers(activity.id, code);
  // A new judgment (已判定 moved, read or pushed): read it again.
  const pushed = useAtomValue(liveJudgedAtom);
  const judged = Math.max(
    activity.judge?.judged ?? 0,
    pushed?.id === activity.id ? pushed.count : 0,
  );
  // Read again at most once per ROSTER_FOLLOW_MS, after the last read, as
  // the 名单 itself: judgments come many a second, and every open 弹窗
  // reading on each was the 2026-11-04 storm again.
  const refetchChallengers = challengers.refetch;
  const [seenJudged, setSeenJudged] = useState(judged);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    if (!code || judged === seenJudged) return;
    setSeenJudged(judged);
    setBehind(true);
  }, [code, judged, seenJudged]);
  const lastRead = challengers.dataUpdatedAt;
  const reading = challengers.isFetching;
  useEffect(() => {
    if (!behind || reading) return;
    const timer = window.setTimeout(
      () => {
        setBehind(false);
        void refetchChallengers({ cancelRefetch: false });
      },
      Math.max(0, lastRead + ROSTER_FOLLOW_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [behind, reading, lastRead, refetchChallengers]);
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
  const openPayment = (paymentId: string) =>
    void navigate({
      to: "/payments/$paymentId",
      params: { paymentId },
      // Leaves the dialog's history entry behind, as closing would.
      replace: true,
    });

  return (
    <RosterPanel
      data={data}
      lists={{
        claims: page.rosterLists.claims.query,
        registrations: page.rosterLists.registrations.query,
      }}
      viewer={page.identity.user?.username ?? null}
      onClose={onClose}
      challengers={code ? challengers : undefined}
      proof={
        proof && (
          <DrawProofLine
            proof={proof}
            done={proofDone}
            onOpen={() => setProofOpen(true)}
          />
        )
      }
      onPayment={openPayment}
    >
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
    </RosterPanel>
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
