import {
  type ClaimActivityInput,
  type PublicActivity,
  passwordSchema,
} from "@hb/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  useActivityPasswords,
  useSolvePassword,
} from "../../lib/activity-passwords";
import { Button } from "../ui/button";
import { ActivityErrorView } from "./activity-error";

export function PasswordPanel({
  activity,
  userId,
  csrfToken,
}: {
  activity: PublicActivity;
  userId: string | null;
  csrfToken: string | null;
}) {
  const query = useActivityPasswords(userId, activity.id);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function copyPassword(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      if (active.current) setCopyStatus("口令已复制。");
    } catch {
      if (active.current) setCopyStatus("复制失败，请选中口令手动复制。");
    }
  }
  return (
    <section
      className="space-y-4 border-t border-neutral-200 pt-5"
      aria-label="活动口令"
    >
      <h2 className="font-semibold">活动口令</h2>
      {query.isPending ? (
        <p role="status" className="text-sm">
          正在读取口令进度…
        </p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.passwords.length ? (
            <ul className="space-y-2 text-sm">
              {query.data.passwords.map((password) => (
                <li
                  key={password.text}
                  className="flex flex-wrap items-center gap-2"
                >
                  <code className="break-all rounded bg-neutral-100 px-2 py-1">
                    {password.text}
                  </code>
                  {password.isClaimPassword ? (
                    <span className="text-neutral-600">我的领奖口令</span>
                  ) : null}
                  {password.isSolved ? (
                    <span className="text-neutral-600">我已解出</span>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={`复制口令 ${password.text}`}
                    onClick={() => void copyPassword(password.text)}
                  >
                    复制
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {copyStatus ? (
            <p role="status" className="text-sm">
              {copyStatus}
            </p>
          ) : null}
          {query.data.hiddenCount > 0 ? (
            <p className="text-sm text-neutral-600">
              还有 {query.data.hiddenCount} 个口令未解锁。
            </p>
          ) : null}
          {query.data.canSolve && userId && csrfToken ? (
            <SolveForm
              key={userId + activity.id}
              userId={userId}
              csrfToken={csrfToken}
              activity={activity}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function SolveForm({
  activity,
  userId,
  csrfToken,
}: {
  activity: PublicActivity;
  userId: string;
  csrfToken: string;
}) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<ClaimActivityInput | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const mutation = useSolvePassword(userId, csrfToken, activity.id);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const seconds =
    retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  async function submit() {
    if (inFlight.current || seconds > 0) return;
    const checked = passwordSchema.safeParse(password);
    if (!pending && !checked.success) {
      setMessage(checked.error.issues[0]?.message ?? "请检查口令格式。");
      return;
    }
    const request = pending ?? {
      submissionId: crypto.randomUUID(),
      password: checked.success ? checked.data : password,
    };
    inFlight.current = true;
    setMessage(null);
    try {
      const result = await mutation.mutateAsync(request);
      if (!active.current) return;
      setPending(null);
      setRetryAt(null);
      setMessage(
        result.outcome === "solved"
          ? "口令已解锁，不会再次领取奖励。"
          : result.outcome === "incorrect"
            ? "口令不正确，请重新尝试。"
            : "活动已结束，口令已公开。",
      );
      if (result.outcome === "solved") setPassword("");
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ActivityRequestError && error.status === 429) {
        setRetryAt(Date.now() + (error.retryAfterSeconds ?? 60) * 1_000);
        setNow(Date.now());
        setMessage("尝试过于频繁，请稍后重试。");
      } else if (
        !(error instanceof ActivityRequestError) ||
        error.status >= 500
      ) {
        setPending(request);
        setMessage("尚未确认解锁结果，请重试原提交。");
      } else {
        setPending(null);
        setMessage(error.message);
      }
    } finally {
      inFlight.current = false;
    }
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="activity-label" htmlFor="solve-password">
        继续解口令
        <input
          id="solve-password"
          className="activity-input"
          value={password}
          disabled={mutation.isPending || Boolean(pending)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <p className="text-xs text-neutral-500">
        已领取后可以继续解出其他口令，不会额外分配奖励。
        {activity.forceDedicated ? "提交内容会进入作者的尝试统计。" : ""}
      </p>
      {message ? (
        <p role="status" className="text-sm text-amber-800">
          {message}
        </p>
      ) : null}
      {seconds > 0 ? (
        <p role="timer" className="text-sm text-neutral-600">
          {seconds} 秒后可重试
        </p>
      ) : null}
      <Button
        type="submit"
        variant="secondary"
        disabled={mutation.isPending || seconds > 0}
      >
        {mutation.isPending ? "正在确认…" : pending ? "重试原提交" : "解锁口令"}
      </Button>
    </form>
  );
}
