import { useAtomValue } from "jotai";
import { Eye, EyeOff, KeyRound, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PasswordLabel, PasswordView } from "../../fixtures/hongbao";
import { verifyNoticeAtom } from "../../lib/store";
import { Button } from "../ui/button";
import { Squircle } from "../ui/squircle";

const filler = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** A stable 12-character stand-in: never the real length or characters. */
function placeholder(seed: string, index: number) {
  let value = 0;
  for (const character of seed)
    value = (value * 31 + character.charCodeAt(0)) % 9973;
  return Array.from(
    { length: 12 },
    (_, position) =>
      filler[(value + (index + 1) * 17 + position * 13) % filler.length],
  ).join("");
}

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
 * who took part can try another one (验证其他口令).
 */
export function PasswordSection({
  activityId,
  passwords,
  onVerify,
}: {
  activityId: string;
  passwords: PasswordView;
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
  useEffect(() => {
    if (!fresh) return;
    (verifyRef.current ?? solvedRef.current)?.focus({ preventScroll: true });
  }, [fresh]);

  // Known 口令 show by default; hiding them (all, or one by one) is for
  // sharing a screen (production's 显示 / 隐藏). Not remembered.
  const [veiled, setVeiled] = useState<ReadonlySet<string>>(() => new Set());
  const known = passwords.known.map((password) => password.text);
  const allVeiled = known.length > 0 && known.every((text) => veiled.has(text));
  const toggle = (text: string) =>
    setVeiled((current) => {
      const next = new Set(current);
      if (next.has(text)) next.delete(text);
      else next.add(text);
      return next;
    });

  const total = passwords.known.length + passwords.hidden;
  if (total === 0) return null;
  return (
    <section className="grid gap-2" data-hb-part="passwords">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-3">
          口令 · {total} 个
          {passwords.hidden > 0 ? ` · ${passwords.hidden} 个未解出` : ""}
        </h2>
        <span className="-mr-2 flex items-center">
          {known.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="显示全部口令"
              aria-pressed={!allVeiled}
              title={allVeiled ? "显示全部口令" : "隐藏全部口令"}
              onClick={() => setVeiled(allVeiled ? new Set() : new Set(known))}
            >
              {allVeiled ? <Eye /> : <EyeOff />}
            </Button>
          )}
          {passwords.canVerify && (
            <Button
              ref={verifyRef}
              id="verify-entry"
              variant="ghost"
              size="sm"
              className="text-accent-ink"
              onClick={onVerify}
            >
              <KeyRound />
              验证其他口令
            </Button>
          )}
        </span>
      </div>
      <ul className="grid gap-1.5">
        {passwords.known.map((password, index) => {
          const solvedNow = fresh?.password === password.text;
          const isVeiled = veiled.has(password.text);
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
                  className={`flex h-11 items-center gap-3 px-3.5 ${
                    solvedNow ? "hb-solved bg-fill" : "bg-fill"
                  }`}
                >
                  {isVeiled ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-base">
                      <span
                        aria-hidden="true"
                        className="text-ink-3 blur-[2.5px] select-none"
                      >
                        {placeholder(password.text, index)}
                      </span>
                      <span className="sr-only">已隐藏</span>
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-mono text-base text-ink">
                      {password.text}
                    </span>
                  )}
                  <span
                    className={`shrink-0 text-xs ${
                      password.label === "solved"
                        ? "font-medium text-success"
                        : "text-ink-3"
                    }`}
                  >
                    {labels[password.label]}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="-mr-2.5 size-8"
                    aria-label={`显示口令 ${index + 1}`}
                    aria-pressed={!isVeiled}
                    title={isVeiled ? "显示" : "隐藏"}
                    onClick={() => toggle(password.text)}
                  >
                    {isVeiled ? <Eye /> : <EyeOff />}
                  </Button>
                </div>
              </Squircle>
            </li>
          );
        })}
        {Array.from({ length: passwords.hidden }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity.
          <li key={index}>
            <Squircle radius={12}>
              <div className="flex h-11 items-center gap-3 bg-fill px-3.5">
                <span
                  aria-hidden="true"
                  className="min-w-0 flex-1 truncate font-mono text-base text-ink-3 blur-[2.5px] select-none"
                >
                  {placeholder(activityId, index)}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-ink-3">
                  <Lock className="size-3.5" aria-hidden="true" />
                  未解出
                </span>
              </div>
            </Squircle>
          </li>
        ))}
      </ul>
      {/* Re-created per result, so the same words are announced again. */}
      <p key={fresh?.token ?? "none"} role="status" className="sr-only">
        {fresh ? "口令已解锁，不会再次领取奖励。" : ""}
      </p>
    </section>
  );
}
