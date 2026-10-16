import { CircleAlert, Info } from "lucide-react";
import { motion } from "motion/react";
import { type EntryScheme, looksLikeAddress } from "../../lib/scheme";
import type { OmniMessage } from "./state";

const actionLabels: Record<NonNullable<OmniMessage["action"]>, string> = {
  login: "登录",
  global: "在全部红包中查找",
};

/** How long the 口令 is against its limit, wherever it shows (02 §6). */
export function PasswordCount({ length }: { length: number }) {
  return (
    <span className="shrink-0 font-mono text-xs text-ink-3 tabular-nums">
      {length} / 18
    </span>
  );
}

/**
 * Resolve what to say under the box: live 口令 rules first, then results.
 * Fixing the 口令 is offered as the first suggestion, not as a link here.
 */
export function resolveMessage(
  value: string,
  scheme: EntryScheme,
  message: OmniMessage | null,
): (OmniMessage & { count?: number }) | null {
  if (scheme.kind === "password" && looksLikeAddress(value))
    return {
      tone: "warning",
      text: "无法识别这个链接。支持本站的红包链接和 LINUX DO 帖子链接。",
    };
  if (scheme.kind === "password" && !scheme.valid)
    return {
      tone: "warning",
      text:
        scheme.message ??
        "口令是 6–18 个字：汉字、英文字母或数字，区分大小写。",
      count: scheme.length,
    };
  return message;
}

export function MessageLine({
  message,
  count = null,
  onAction,
}: {
  message: (OmniMessage & { count?: number }) | null;
  /** A 口令's length to show with no message (the start page's valid one). */
  count?: number | null;
  onAction: (action: OmniMessage["action"]) => void;
}) {
  const length = message?.count ?? count;
  if (!message && length === null) return null;
  const Icon = message?.tone === "neutral" ? Info : CircleAlert;
  return (
    // Not a live region: Omnibox announces results from one lasting
    // region, and the rules line (with its count) is not read per keystroke.
    // The count keeps its place as the rules come and go beside it.
    <div className="flex items-start gap-2 text-sm">
      {message ? (
        <motion.span
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16 }}
          className="flex min-w-0 flex-1 items-start gap-2"
        >
          <Icon
            aria-hidden="true"
            className={`mt-[3px] size-4 shrink-0 ${
              message.tone === "danger"
                ? "text-danger"
                : message.tone === "warning"
                  ? "text-warning"
                  : "text-ink-3"
            }`}
          />
          <span className="min-w-0 flex-1 text-ink-2">
            {message.text}
            {message.action && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onAction(message.action)}
                className="ml-2 font-medium text-accent-ink underline-offset-4 hover:underline"
              >
                {actionLabels[message.action]}
              </button>
            )}
          </span>
        </motion.span>
      ) : (
        <span className="flex-1" />
      )}
      {length !== null && <PasswordCount length={length} />}
    </div>
  );
}
