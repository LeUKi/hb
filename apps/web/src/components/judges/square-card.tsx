import type { SquareJudge } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { radius, Squircle } from "../ui/squircle";
import { JudgeMark, JudgeSource, JudgeTags, statsLine } from "./judge-bits";

/**
 * A 判定器 in the 广场 (§8 卡片): what it is, whose, its numbers and tags;
 * 用它发红包 and 查看; one waiting for its author (在更新, §17, or a
 * 旧判定器) says why instead.
 */
export function SquareJudgeCard({
  judge,
  signedIn,
  onPick,
  busy = false,
}: {
  judge: SquareJudge;
  signedIn: boolean;
  /** In 发红包's picker: 用这个 and 查看 ↗ (a new tab) instead. */
  onPick?: () => void;
  busy?: boolean;
}) {
  const navigate = useNavigate();
  const { openAccount } = useOmniboxController();
  const waiting = waitingWords(judge);
  return (
    <Squircle radius={radius.card}>
      <article className="panel grid h-full content-start gap-2.5 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <JudgeMark />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <h3 className="truncate text-base font-semibold text-ink">
              {judge.name}
            </h3>
            <span className="text-xs text-ink-3">
              <JudgeSource judge={judge} />
            </span>
          </div>
        </div>
        {judge.description && (
          <p className="line-clamp-2 text-sm text-ink-2">{judge.description}</p>
        )}
        <p className="text-xs text-ink-3">{statsLine(judge.stats)}</p>
        <JudgeTags judge={judge} />
        <div className="mt-1 flex flex-wrap items-center gap-2 self-end">
          {waiting ? (
            <span className="text-sm text-ink-3">{waiting}</span>
          ) : onPick ? (
            <>
              <Button
                variant="primary"
                size="sm"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) onPick();
                }}
              >
                用这个
              </Button>
              <ButtonLink href={`/judges/${encodeURIComponent(judge.id)}`}>
                查看 ↗
              </ButtonLink>
            </>
          ) : signedIn ? (
            <ButtonLink
              variant="primary"
              href={`/new?judge=${encodeURIComponent(judge.id)}`}
              onGo={() =>
                void navigate({ to: "/new", search: { judge: judge.id } })
              }
            >
              用它发红包
            </ButtonLink>
          ) : (
            <Button variant="primary" size="sm" onClick={openAccount}>
              用它发红包
            </Button>
          )}
          {onPick && waiting && (
            <ButtonLink href={`/judges/${encodeURIComponent(judge.id)}`}>
              查看 ↗
            </ButtonLink>
          )}
          {!onPick && (
            <ButtonLink
              href={`/judges/${encodeURIComponent(judge.id)}`}
              onGo={() =>
                void navigate({
                  to: "/judges/$judgeId",
                  params: { judgeId: judge.id },
                })
              }
            >
              查看
            </ButtonLink>
          )}
        </div>
      </article>
    </Squircle>
  );
}

/**
 * Why others can't use it now, in place of 用它发红包: its author has a
 * newer version that has not opened a 红包 (在更新, judge-square §17), or
 * it is a 旧判定器 (multi-prize §3.6); null when they can.
 */
export function waitingWords(judge: Pick<SquareJudge, "old" | "updating">) {
  if (judge.updating !== undefined) return "作者在更新，新版本发过红包后才能用";
  if (judge.old) return "作者还没按新规则更新";
  return null;
}
