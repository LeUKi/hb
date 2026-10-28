import type { SquareJudge } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { radius, Squircle } from "../ui/squircle";
import { JudgeMark, JudgeSource, JudgeTags, statsLine } from "./judge-bits";

/**
 * A 判定器 in the 广场 (§8 卡片): what it is, whose, its numbers and tags;
 * 用它发红包 and 查看.
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
        <div className="mt-1 flex flex-wrap gap-2 self-end">
          {onPick ? (
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
