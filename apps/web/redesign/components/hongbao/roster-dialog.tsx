import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useState } from "react";
import type { FixtureActivity } from "../../fixtures/activities";
import {
  fuzzyLabels,
  type PublicView,
  publicOf,
  type RosterRow,
  rosterOf,
} from "../../fixtures/hongbao";
import { entryPayment } from "../../fixtures/payments";
import { clockLabel } from "../../lib/roster-time";
import { sessionAtom } from "../../lib/store";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Squircle } from "../ui/squircle";
import {
  RosterHeader,
  type RosterKind,
  RosterList,
  type RowDetail,
} from "./roster";
import { useViewerContext } from "./use-hongbao";

/** The context a screenshot needs: how much was taken, and when it opened. */
function metaLine(activity: FixtureActivity, view: PublicView) {
  const parts: string[] = [];
  const { draw, quantity } = view;
  if (draw) {
    if (draw.registered === null) parts.push("名额不公开");
    else parts.push(`报名 ${draw.registered} 人`, `抽 ${activity.shares} 人`);
  } else if (quantity.kind === "fuzzy") {
    parts.push(`余量${fuzzyLabels[quantity.level]}`);
  } else {
    parts.push(`已领 ${quantity.taken} / ${quantity.total} 份`);
  }
  if (!(activity.mode === "fixed" && quantity.kind === "fuzzy"))
    parts.push(`${activity.totalAmount} LDC`);
  parts.push(`${clockLabel(view.openedAt)} 开放`);
  return parts.join(" · ");
}

function Tabs({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <Squircle radius={12}>
      <div role="tablist" className="mx-5 mb-3 flex bg-fill-2 p-0.5">
        {options.map(([key, label]) => (
          <Squircle key={key} radius={10}>
            <button
              type="button"
              role="tab"
              aria-selected={value === key}
              onClick={() => onChange(key)}
              className={`h-8 flex-1 px-3 text-sm whitespace-nowrap transition-colors ${
                value === key
                  ? "bg-white font-medium text-ink raised"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              {label}
            </button>
          </Squircle>
        ))}
      </div>
    </Squircle>
  );
}

function RosterBody({
  activity,
  onClose,
}: {
  activity: FixtureActivity;
  onClose: () => void;
}) {
  const context = useViewerContext(activity);
  const user = useAtomValue(sessionAtom);
  const navigate = useNavigate();
  const view = publicOf(activity, context);
  const roster = rosterOf(activity, context, user?.displayName ?? null);
  const [tab, setTab] = useState("winners");
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
  const title =
    kind === "claims"
      ? "领取名单"
      : kind === "winners"
        ? "中奖名单"
        : "报名名单";
  const count = (value: number) => (fuzzy ? "" : ` ${value}`);
  const author = activity.author.displayName;
  // The sender also sees, per row, the 口令 used and the payment (production's
  // author roster API returns both; only the sender's own 红包).
  const isSender = Boolean(context.author);
  const detailOf = (row: RosterRow): RowDetail | null => {
    const index = /^e(\d+)$/.exec(row.id)?.[1];
    if (index === undefined) return null;
    const payment =
      kind === "registrations"
        ? null
        : entryPayment(activity.id, Number(index));
    const password =
      activity.participation === "password" && activity.passwords.length > 0
        ? (activity.passwords[Number(index) % activity.passwords.length] ??
          null)
        : null;
    if (!password && !payment) return null;
    return {
      password,
      payment: payment ? { id: payment.id, state: payment.state } : null,
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
            {fuzzy ? "" : ` · ${rows.length} 人`}
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
          <Avatar name={author} size={18} />
          <span className="truncate">
            {author}的红包 · {activity.title}
          </span>
        </p>
        <p className="text-xs text-ink-3">{metaLine(activity, view)}</p>
        {isSender && (
          <p className="text-xs text-gold-ink">
            你发的红包：每行多一行
            {activity.participation === "password"
              ? "口令和付款状态"
              : "付款状态"}
            ，只有你能看到。
          </p>
        )}
      </header>
      {roster.kind === "draw" && (
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            ["winners", `中奖名单${count(roster.winners.length)}`],
            ["registrations", `报名名单${count(roster.registrations.length)}`],
          ]}
        />
      )}
      <RosterHeader kind={kind} />
      {/* The list's own scroller: its end row is watched in it. */}
      <div className="view-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <RosterList
          key={kind}
          rows={rows}
          kind={kind}
          openedAt={view.openedAt}
          showCount={!fuzzy}
          detailOf={isSender ? detailOf : undefined}
          onPayment={openPayment}
        />
      </div>
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
      {(activity, close) => <RosterBody activity={activity} onClose={close} />}
    </PanelDialog>
  );
}
