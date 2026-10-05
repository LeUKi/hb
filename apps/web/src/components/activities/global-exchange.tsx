import { passwordSchema } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  exchangeContextAtom,
  useGlobalRedemption,
  useRedemptionResult,
} from "../../lib/discovery";
import { Button } from "../ui/button";
import { ActivityErrorView } from "./activity-error";
import { DiscoveryCards } from "./discovery-cards";
import { ListPagination } from "./list-pagination";
import { PasswordField } from "./password-field";

export function GlobalExchange({
  userId,
  csrfToken,
}: {
  userId: string;
  csrfToken: string;
}) {
  const [context, setContext] = useAtom(exchangeContextAtom);
  const ownContext = context?.userId === userId ? context : null;
  const [password, setPassword] = useState(ownContext?.password ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const mutation = useGlobalRedemption(userId, csrfToken);
  const resultQuery = useRedemptionResult(
    userId,
    ownContext?.resultId ?? null,
    cursors.at(-1) ?? null,
  );
  const navigate = useNavigate();
  const seconds =
    retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  const uncertain = ownContext?.state === "unconfirmed";

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function submit() {
    if (inFlight.current || seconds > 0) return;
    const checked = passwordSchema.safeParse(password);
    if (!uncertain && !checked.success) {
      setMessage(checked.error.issues[0]?.message ?? "请检查兑换口令。");
      return;
    }
    const submission = uncertain
      ? ownContext.submission
      : {
          submissionId: crypto.randomUUID(),
          password: checked.success ? checked.data : password,
        };
    setMessage(null);
    setContext({
      userId,
      password: submission.password,
      submission,
      resultId: null,
      state: "unconfirmed",
      selectedActivityId: null,
    });
    setCursors([null]);
    inFlight.current = true;
    try {
      const result = await mutation.mutateAsync(submission);
      if (!alive.current) return;
      const selected =
        result.result === "single"
          ? (result.selectedActivityId ?? result.items[0]?.id ?? null)
          : null;
      setContext({
        userId,
        password: submission.password,
        submission,
        resultId: result.id,
        state: "resolved",
        selectedActivityId: selected,
      });
      setRetryAt(null);
      if (selected)
        void navigate({ to: "/activities/$id", params: { id: selected } });
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ActivityRequestError && error.status === 429) {
        setRetryAt(Date.now() + (error.retryAfterSeconds ?? 60) * 1000);
        setNow(Date.now());
        setMessage("尝试过于频繁，请稍后重试原提交，不会重新选择其他活动。");
      } else if (
        !(error instanceof ActivityRequestError) ||
        error.status >= 500
      ) {
        setMessage("尚未确认兑换结果，请重试原提交，不会重新选择其他活动。");
      } else {
        setContext(null);
        setMessage(error.message);
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="space-y-5">
      <form
        className="activity-panel space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h1 className="text-2xl font-semibold">口令兑奖</h1>
        <PasswordField
          value={password}
          onChange={setPassword}
          disabled={mutation.isPending || uncertain}
        />
        <p className="text-sm leading-6 text-neutral-600">
          只有一个匹配活动时直接领取；多个匹配活动时先选择活动，再确认领取。
        </p>
        {message ? (
          <p role="status" className="text-sm text-amber-800">
            {message}
          </p>
        ) : null}
        {uncertain && !mutation.isPending && !message ? (
          <p role="status" className="text-sm text-amber-800">
            上次提交结果尚未确认，请重试原提交。
          </p>
        ) : null}
        {seconds > 0 ? (
          <p role="timer" className="text-sm text-neutral-600">
            {seconds} 秒后可重试
          </p>
        ) : null}
        <Button type="submit" disabled={mutation.isPending || seconds > 0}>
          {mutation.isPending ? "正在确认…" : uncertain ? "重试原提交" : "兑换"}
        </Button>
      </form>
      {ownContext?.resultId ? (
        <section className="space-y-4" aria-label="匹配活动">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">匹配活动</h2>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => resultQuery.refetch()}
              disabled={resultQuery.isFetching}
            >
              刷新列表
            </Button>
          </div>
          {resultQuery.isPending ? (
            <p role="status">正在读取匹配结果…</p>
          ) : resultQuery.isError ? (
            <ActivityErrorView
              error={resultQuery.error}
              retry={() => resultQuery.refetch()}
            />
          ) : (
            <>
              {resultQuery.data.items.length ? (
                <DiscoveryCards
                  items={resultQuery.data.items}
                  onSelect={(id) =>
                    setContext((current) =>
                      current?.userId === userId
                        ? { ...current, selectedActivityId: id }
                        : current,
                    )
                  }
                />
              ) : (
                <p className="activity-panel text-sm text-neutral-600">
                  {resultQuery.data.result === "none"
                    ? "未匹配到活动。"
                    : "匹配的活动已不在可兑换列表中。"}
                </p>
              )}
              {resultQuery.data.nextCursor || cursors.length > 1 ? (
                <ListPagination
                  cursors={cursors}
                  setCursors={setCursors}
                  nextCursor={resultQuery.data.nextCursor}
                />
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
