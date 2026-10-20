import { useNavigate, useRouter } from "@tanstack/react-router";
import { BarChart3, PenLine, ReceiptText, UsersRound } from "lucide-react";
import {
  activityCode,
  type SenderPage,
  senderPagePath,
  senderPages,
} from "../../lib/activity-route";
import type { HongbaoActivity } from "../../lib/hongbao";
import { openOverlay } from "../../lib/overlay";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";

// 付款记录 is the receipt everywhere (the account's /payments too); the 名单
// is people, so the two never look alike.
const icons = { edit: PenLine, stats: BarChart3, payments: ReceiptText };

/** Button words: the page names, but 编辑 for 编辑红包 (the 红包 is right there). */
const labels: Record<SenderPage, string> = {
  edit: "编辑",
  stats: "尝试统计",
  payments: "付款记录",
};

/**
 * A draft has only 编辑; 尝试统计 exists only for 红包 sent with it on;
 * a 🐟额红包 pays nothing out, so it has no 付款记录 (balance-design §14).
 */
export function senderPagesOf(activity: HongbaoActivity): SenderPage[] {
  if (activity.draft) return ["edit"];
  const pages: SenderPage[] = activity.statistics
    ? ["edit", "stats"]
    : ["edit"];
  return activity.fish ? pages : [...pages, "payments"];
}

/**
 * The sender's 📝 / 📊 / 🧾 pages of one 红包, the same everywhere: labelled
 * on the 红包 page and on narrow 红包记录 rows, icons with names in a wide
 * row. Real links, so they can open in a new tab. A list row also has the
 * 名单, opened in place as the 名单弹窗 (the 红包 page has its 名单入口).
 */
export function SenderLinks({
  activity,
  iconsOnly = false,
  inRow = false,
  draftFirst = false,
  inList = false,
}: {
  activity: HongbaoActivity;
  iconsOnly?: boolean;
  /** Inside a clickable row, which must not open the 红包 as well. */
  inRow?: boolean;
  /** A draft's 继续编辑 is the page's main action. */
  draftFirst?: boolean;
  /**
   * A 红包记录 row: with the 名单 (before 付款记录: who took part, then
   * what they were paid), and labelled ones in the small inline size.
   */
  inList?: boolean;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const size = iconsOnly ? "icon-sm" : inList ? "xs" : "sm";
  const links = senderPagesOf(activity).map((page) => {
    const Icon = icons[page];
    const primary = draftFirst && page === "edit" && activity.draft;
    return (
      <ButtonLink
        key={page}
        href={senderPagePath(activity.id, page)}
        onGo={() =>
          void navigate({
            to: `/🧧/$code/${senderPages[page].emoji}` as "/🧧/$code/📝",
            params: { code: activityCode(activity.id) },
          })
        }
        stopPropagation={inRow}
        variant={primary ? "primary" : "ghost"}
        size={size}
        aria-label={
          iconsOnly
            ? `${senderPages[page].title}「${activity.title}」`
            : undefined
        }
        title={iconsOnly ? senderPages[page].title : undefined}
      >
        <Icon aria-hidden="true" />
        {!iconsOnly && (primary ? "继续编辑" : labels[page])}
      </ButtonLink>
    );
  });
  // A draft has nobody on its 名单 yet.
  if (!inList || activity.draft) return links;
  const roster = (
    <Button
      key="roster"
      id={`roster-entry-${activity.id}`}
      variant="ghost"
      size={size}
      aria-haspopup="dialog"
      aria-label={iconsOnly ? `名单「${activity.title}」` : undefined}
      title={iconsOnly ? "名单" : undefined}
      onClick={(event) => {
        if (inRow) event.stopPropagation();
        openOverlay(router, { panel: "roster", panelFor: activity.id });
      }}
    >
      <UsersRound aria-hidden="true" />
      {!iconsOnly && "名单"}
    </Button>
  );
  return [...links.slice(0, -1), roster, ...links.slice(-1)];
}
