import { useAtomValue } from "jotai";
import { ChevronDown, KeyRound, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PasswordLabel, PasswordView } from "../../lib/hongbao";
import { verifyNoticeAtom } from "../../lib/store";
import { Button } from "../ui/button";
import { RollingText } from "../ui/morph-label";
import { Reveal } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { PasswordText, RevealToggle, StandIn } from "./password-text";

/** Rows shown before 展开全部 (up to 32 口令 since 2026-10-25, 05 §2). */
const FOLDED = 5;

const labels: Record<PasswordLabel, string> = {
  registered: "已用此口令报名",
  claimed: "已用此口令领取",
  solved: "已解出",
  public: "已公开",
  own: "你设置的",
};

/**
 * 口令区: the count is public; the 口令 stay hidden until the viewer took part
 * (their own, plus any they verify) or the 红包 ended (all of them). Someone
 * who took part can try another one (验证其他口令). While it runs, even the
 * known ones start hidden behind an eye; once it ended they are all plain.
 */
export function PasswordSection({
  activityId,
  passwords,
  ended,
  onVerify,
}: {
  activityId: string;
  passwords: PasswordView;
  ended: boolean;
  onVerify: () => void;
}) {
  const notice = useAtomValue(verifyNoticeAtom);
  // Only results that arrive while this page is open highlight and announce.
  const [shownAt] = useState(() => Date.now());
  const fresh =
    notice?.activityId === activityId && notice.token >= shownAt
      ? notice
      : null;
  const verifyRef = useRef<HTMLButtonElement>(null);
  const solvedRef = useRef<HTMLLIElement>(null);
  // A verified 口令 hands focus back from the box: to the button while more
  // remain, else to the row it just revealed.
  // Results said so far: the announcement alternates its full stop, so the
  // same words are said again for the next one.
  const [said, setSaid] = useState(0);
  useEffect(() => {
    if (!fresh) return;
    setSaid((count) => count + 1);
    (verifyRef.current ?? solvedRef.current)?.focus({ preventScroll: true });
  }, [fresh]);

  // Shown while it runs: only those the viewer asked for (all, or one by
  // one), a newly solved one included. Not remembered.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const known = passwords.known.map((password) => password.text);
  const isShown = (text: string) => ended || revealed.has(text);
  const allShown = known.every(isShown);
  const toggle = (text: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(text)) next.delete(text);
      else next.add(text);
      return next;
    });

  const total = passwords.known.length + passwords.hidden;
  // Many 口令 fold under 展开全部; one just solved down there opens them
  // once its row arrives (the list is read again after the result), in the
  // same render, so focus can land on it.
  const [expanded, setExpanded] = useState(false);
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  const solvedAt = fresh
    ? passwords.known.findIndex((password) => password.text === fresh.password)
    : -1;
  if (fresh && solvedAt >= 0 && openedFor !== fresh.token) {
    setOpenedFor(fresh.token);
    if (solvedAt >= FOLDED) setExpanded(true);
  }
  if (total === 0) return null;
  const rows = [
    ...passwords.known.map((password, index) => {
      const solvedNow = fresh?.password === password.text;
      return (
        <li
          key={password.text}
          ref={solvedNow ? solvedRef : undefined}
          tabIndex={solvedNow ? -1 : undefined}
          className="outline-none"
        >
          <Squircle radius={12}>
            <div
              key={solvedNow ? fresh.token : undefined}
              className={`flex min-h-11 items-center gap-3 px-3.5 py-2.5 ${
                solvedNow ? "hb-solved bg-fill" : "bg-fill"
              }`}
            >
              {/* A long 口令 wraps; a narrow window puts the label under
                  it, so the 口令 has the whole line. */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 @wide/window:flex-row @wide/window:items-center @wide/window:gap-3">
                <PasswordText
                  text={password.text}
                  shown={isShown(password.text)}
                  seed={`${activityId}:known`}
                  index={index}
                  wrap
                  className="min-w-0 flex-1 text-base text-ink"
                />
                <span
                  data-morph="move"
                  className={`shrink-0 text-xs ${
                    password.label === "solved"
                      ? "font-medium text-success"
                      : "text-ink-3"
                  }`}
                >
                  {labels[password.label]}
                </span>
              </span>
              {!ended && (
                <RevealToggle
                  what={`口令 ${index + 1}`}
                  shown={isShown(password.text)}
                  onToggle={() => toggle(password.text)}
                  className="-mr-1.5"
                />
              )}
            </div>
          </Squircle>
        </li>
      );
    }),
    ...Array.from({ length: passwords.hidden }, (_, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity.
      <li key={index}>
        <Squircle radius={12}>
          <div className="flex h-11 items-center gap-3 bg-fill px-3.5">
            <StandIn
              seed={activityId}
              index={index}
              className="min-w-0 flex-1 truncate font-mono text-base"
            />
            <span className="flex shrink-0 items-center gap-1 text-xs text-ink-3">
              <Lock className="size-3.5" aria-hidden="true" />
              未解出
            </span>
          </div>
        </Squircle>
      </li>
    )),
  ];
  return (
    <section className="flex flex-col gap-2" data-hb-part="passwords">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-3">
          <RollingText
            text={`口令 · ${total} 个${passwords.hidden > 0 ? ` · ${passwords.hidden} 个未解出` : ""}`}
          />
        </h2>
        <span className="-mr-2 flex items-center">
          {!ended && known.length > 0 && (
            <RevealToggle
              size="icon-sm"
              what="全部口令"
              shown={allShown}
              onToggle={() =>
                setRevealed(allShown ? new Set() : new Set(known))
              }
            />
          )}
          {passwords.canVerify && (
            <Button
              ref={verifyRef}
              id="verify-entry"
              variant="secondary"
              size="sm"
              className="ml-1"
              onClick={onVerify}
            >
              <KeyRound />
              验证其他口令
            </Button>
          )}
        </span>
      </div>
      {/* Past FOLDED the rest wait under 展开全部, opening in place. */}
      <div className="flex flex-col gap-1.5">
        <ul className="grid gap-1.5" data-morph-children="move">
          {rows.slice(0, FOLDED)}
        </ul>
        <Reveal show={expanded}>
          <ul
            id={`${activityId}-more-passwords`}
            className="grid gap-1.5"
            data-morph-children="move"
          >
            {rows.slice(FOLDED)}
          </ul>
        </Reveal>
      </div>
      {total > FOLDED && (
        <Button
          variant="ghost"
          size="sm"
          className="self-center"
          aria-expanded={expanded}
          aria-controls={`${activityId}-more-passwords`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "收起" : `展开全部 ${total} 个`}
          <ChevronDown
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      )}
      {/* Always there, so a result is announced; the full stop alternates,
          so the same words are said again for the next one. */}
      <p role="status" className="sr-only">
        {fresh ? `口令已解出，不会再领一次${said % 2 ? "。" : ""}` : ""}
      </p>
    </section>
  );
}
