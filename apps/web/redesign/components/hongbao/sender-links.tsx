import { useNavigate } from "@tanstack/react-router";
import { BarChart3, PenLine, ReceiptText } from "lucide-react";
import type { FixtureActivity } from "../../fixtures/activities";
import {
  activityCode,
  type SenderPage,
  senderPagePath,
  senderPages,
} from "../../lib/activity-route";
import { ButtonLink } from "../ui/button-link";

const icons = { edit: PenLine, stats: BarChart3, payments: ReceiptText };

/** Button words: the page names, but 编辑 for 编辑红包 (the 红包 is right there). */
const labels: Record<SenderPage, string> = {
  edit: "编辑",
  stats: "尝试统计",
  payments: "付款记录",
};

/** A draft has only 编辑; 尝试统计 exists only for 红包 sent with it on. */
export function senderPagesOf(activity: FixtureActivity): SenderPage[] {
  if (activity.draft) return ["edit"];
  return activity.statistics
    ? ["edit", "stats", "payments"]
    : ["edit", "payments"];
}

/**
 * The sender's 📝 / 📊 / 🧾 pages of one 红包, the same everywhere: labelled
 * on the 红包 page and on narrow 红包记录 rows, icons with names in a wide
 * row. Real links, so they can open in a new tab.
 */
export function SenderLinks({
  activity,
  iconsOnly = false,
  inRow = false,
  draftFirst = false,
}: {
  activity: FixtureActivity;
  iconsOnly?: boolean;
  /** Inside a clickable row, which must not open the 红包 as well. */
  inRow?: boolean;
  /** A draft's 继续编辑 is the page's main action. */
  draftFirst?: boolean;
}) {
  const navigate = useNavigate();
  return senderPagesOf(activity).map((page) => {
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
        size={iconsOnly ? "icon-sm" : "sm"}
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
}
