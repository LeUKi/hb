import { useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { haptic } from "../../lib/haptics";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { SplitButton } from "../ui/split-button";

/** The way in to send a 红包 with this 判定器 (judge-square §6). */
export const sendWithJudgePath = (judgeId: string) =>
  `/new?judge=${encodeURIComponent(judgeId)}`;

/**
 * 用它发红包 ▾ on the 广场's cards and a 判定器's page, one's own too while
 * others can use it (the user, 2026-11-21, 2026-11-22): the arrow has
 * 复制用它发红包的链接, /new?judge=<编号> (not the page's own link: 复制链接
 * alone read as that), to pass the way in on; the button says 已复制 for a
 * moment. A guest signs in first; the link copies all the same.
 */
export function SendWithJudge({
  judgeId,
  signedIn,
}: {
  judgeId: string;
  signedIn: boolean;
}) {
  const navigate = useNavigate();
  const { openAccount } = useOmniboxController();
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const path = sendWithJudgePath(judgeId);
  const copy = () => {
    const write = navigator.clipboard?.writeText(
      `${window.location.origin}${path}`,
    );
    if (!write) return setCopied("failed");
    write.then(
      () => {
        haptic("light");
        setCopied("done");
      },
      () => setCopied("failed"),
    );
  };
  return (
    <>
      <SplitButton
        size="sm"
        href={signedIn ? path : undefined}
        onClick={() => {
          if (signedIn)
            void navigate({ to: "/new", search: { judge: judgeId } });
          else openAccount();
        }}
        menuLabel="用它发红包的更多做法"
        items={[{ label: "复制用它发红包的链接", onSelect: copy }]}
      >
        {/* Pieces, as share-dialog's copyFace: the words morph. */}
        {[
          copied === "done" ? <Check key="done" aria-hidden="true" /> : null,
          copied === "done"
            ? "已复制"
            : copied === "failed"
              ? "复制失败"
              : "用它发红包",
        ]}
      </SplitButton>
      <span role="status" className="sr-only">
        {copied === "done"
          ? "已复制用它发红包的链接"
          : copied === "failed"
            ? "复制失败"
            : ""}
      </span>
    </>
  );
}
