import {
  type PasswordClaimInput,
  type PublicActivity,
  passwordSchema,
} from "@hb/contracts";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  type useActivityPasswords,
  useSolvePassword,
} from "../../lib/activity-passwords";
import { useAttemptCooldown } from "../../lib/attempt-cooldown";
import { useAccountSession } from "../../lib/auth";
import { isDirectParticipation } from "../../lib/direct-participation";
import { isBlockingQueryError } from "../../lib/query-view";
import { CompactIconButton } from "../presentation/compact-icon-button";
import { Help } from "../presentation/context-help";
import { RefreshNotice, SkeletonRows } from "../presentation/loading";
import { PasswordInput } from "../presentation/password-input";
import { PasswordReveal } from "../presentation/password-reveal";
import { ActivityErrorView } from "./activity-error";

type KnownPasswordItem = {
  text: string;
  label?: string;
};

type LockedPasswordItem = {
  hiddenCount: number;
  scope: string;
};

type PasswordPresentationItem =
  | ({ kind: "known" } & KnownPasswordItem)
  | ({ kind: "locked" } & LockedPasswordItem);

const placeholderAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const lockedPlaceholders = new Map<string, string[]>();

function createPlaceholder() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(
    bytes,
    (byte) => placeholderAlphabet[byte % placeholderAlphabet.length],
  ).join("");
}

function placeholdersFor({ hiddenCount, scope }: LockedPasswordItem): string[] {
  const count =
    Number.isSafeInteger(hiddenCount) && hiddenCount > 0 ? hiddenCount : 0;
  let cached = lockedPlaceholders.get(scope);
  if (!cached) {
    cached = [];
    lockedPlaceholders.set(scope, cached);
  }
  while (cached.length < count) cached.push(createPlaceholder());
  return cached.slice(0, count);
}

function LockedPasswords(props: LockedPasswordItem) {
  return placeholdersFor(props).map((placeholder) => (
    <div
      key={`${props.scope}:${placeholder}`}
      className="pw-locked"
      data-password-state="locked"
    >
      <span className="pw-locked__value" aria-hidden="true">
        {placeholder}
      </span>
      <span className="pw-locked__status">
        <LockKeyhole size={14} aria-hidden="true" />
        <span>未解出</span>
      </span>
    </div>
  ));
}

function knownKey(scope: string, item: KnownPasswordItem) {
  return `${scope}:known:${item.text}`;
}

function PasswordList({
  known,
  hiddenCount,
  scope,
  heading,
  defaultRevealed = true,
}: {
  known: readonly KnownPasswordItem[];
  hiddenCount: number;
  scope: string;
  heading?: ReactNode;
  defaultRevealed?: boolean;
}) {
  const identity = JSON.stringify([scope, defaultRevealed]);
  return (
    <PasswordListSession
      key={identity}
      known={known}
      hiddenCount={hiddenCount}
      scope={scope}
      heading={heading}
      defaultRevealed={defaultRevealed}
    />
  );
}

function PasswordListSession({
  known,
  hiddenCount,
  scope,
  heading,
  defaultRevealed,
}: {
  known: readonly KnownPasswordItem[];
  hiddenCount: number;
  scope: string;
  heading?: ReactNode;
  defaultRevealed: boolean;
}) {
  const keys = known.map((item) => knownKey(scope, item));
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const pinned = new Set(
    keys.filter((key) => choices.get(key) ?? defaultRevealed),
  );
  const [bulkHideVersion, setBulkHideVersion] = useState(0);
  const hasKnown = keys.length > 0;
  const allPinned = hasKnown && keys.every((key) => pinned.has(key));
  const items: PasswordPresentationItem[] = [
    ...known.map((item) => ({ ...item, kind: "known" as const })),
    { kind: "locked", hiddenCount, scope },
  ];

  return (
    <>
      {heading && (
        <div className="section-heading password-list-heading">
          <div className="password-list-title">
            {heading}
            <CompactIconButton
              className="password-list-title__eye"
              aria-label={allPinned ? "隐藏全部口令" : "显示全部口令"}
              aria-pressed={allPinned}
              disabled={!hasKnown}
              onClick={() => {
                if (!hasKnown) return;
                if (allPinned) {
                  setChoices(new Map(keys.map((key) => [key, false])));
                  setBulkHideVersion((version) => version + 1);
                } else setChoices(new Map(keys.map((key) => [key, true])));
              }}
            >
              {allPinned ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
            </CompactIconButton>
          </div>
        </div>
      )}
      <div className="password-list password-display-list">
        {items.map((item) => {
          if (item.kind === "known") {
            const key = knownKey(scope, item);
            return (
              <PasswordReveal
                key={key}
                text={item.text}
                label={item.label}
                scope={scope}
                pinned={pinned.has(key)}
                bulkHideVersion={bulkHideVersion}
                onPinnedChange={(nextPinned) =>
                  setChoices((current) => {
                    const next = new Map(current);
                    next.set(key, nextPinned);
                    return next;
                  })
                }
              />
            );
          }
          return (
            <LockedPasswords
              key={`${scope}:locked`}
              hiddenCount={item.hiddenCount}
              scope={item.scope}
            />
          );
        })}
      </div>
    </>
  );
}

function passwordLabel(password: {
  isClaimPassword: boolean;
  isRegistrationPassword?: boolean;
  isSolved: boolean;
}) {
  if (password.isRegistrationPassword) return "已用此口令报名";
  if (password.isClaimPassword) return "已用此口令兑换";
  return password.isSolved ? "已解出" : undefined;
}

export function PasswordPanel({
  activity,
  activityId,
  placeholderPending = true,
  query,
  userId,
  csrfToken,
}: {
  activity?: PublicActivity;
  activityId?: string;
  placeholderPending?: boolean;
  query: ReturnType<typeof useActivityPasswords>;
  userId: string | null;
  csrfToken: string | null;
}) {
  const id = activity?.id ?? activityId ?? "";
  const reducedMotion = useReducedMotion();
  const layoutAnimation = reducedMotion ? undefined : ("position" as const);
  const layoutTransition = reducedMotion
    ? undefined
    : { layout: { duration: 0.22, ease: "easeOut" as const } };
  if (isDirectParticipation(activity)) return null;
  return (
    <motion.section
      className="password-section"
      aria-label="活动口令"
      layout={layoutAnimation}
      transition={layoutTransition}
    >
      {!activity || query.isPending ? (
        <div aria-busy={Boolean(activity) || placeholderPending}>
          {(activity || placeholderPending) && <SkeletonRows rows={2} />}
        </div>
      ) : isBlockingQueryError(query) || !query.data ? (
        <ActivityErrorView
          error={query.error ?? new Error("读取口令失败")}
          retry={() => query.refetch()}
        />
      ) : (
        <>
          <RefreshNotice query={query} />
          <PasswordList
            defaultRevealed
            known={query.data.passwords.map((password) => ({
              text: password.text,
              label: passwordLabel(password),
            }))}
            hiddenCount={query.data.hiddenCount}
            scope={`${userId ?? "guest"}:${id}`}
            heading={<h2>活动口令</h2>}
          />
          {query.data.canSolve && userId && csrfToken ? (
            <SolveForm
              key={userId + activity.id}
              userId={userId}
              csrfToken={csrfToken}
              activity={activity}
              hiddenCount={query.data.hiddenCount}
            />
          ) : null}
        </>
      )}
    </motion.section>
  );
}

function SolveForm({
  activity,
  userId,
  csrfToken,
  hiddenCount,
}: {
  activity: PublicActivity;
  userId: string;
  csrfToken: string;
  hiddenCount: number;
}) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PasswordClaimInput | null>(null);
  const mutation = useSolvePassword(userId, csrfToken, activity.id);
  const account = useAccountSession(userId);
  const active = useRef(true);
  const inFlight = useRef(false);
  const cooldown = useAttemptCooldown(userId);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const blockedByCooldown = !pending && cooldown.active;
  const seconds = blockedByCooldown ? cooldown.seconds : 0;
  async function submit() {
    if (inFlight.current || blockedByCooldown) return;
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
    const identity = account.captureIdentity();
    try {
      const result = await mutation.mutateAsync(request);
      if (!active.current || !account.isCurrentIdentity(identity)) return;
      setPending(null);
      setMessage(
        result.outcome === "solved"
          ? "口令已解锁，不会再次领取奖励。"
          : result.outcome === "incorrect"
            ? "口令不正确，请重新尝试。"
            : "活动已结束，口令已公开。",
      );
      if (result.outcome === "solved") setPassword("");
    } catch (error) {
      if (!active.current || !account.isCurrentIdentity(identity)) return;
      if (error instanceof ActivityRequestError && error.status === 429) {
        setPending(null);
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
    <div className="solve-row">
      <div className="solve-heading">
        <h3>验证其他口令</h3>
        <span className="muted">剩余 {hiddenCount} 个</span>
        <Help label="验证其他口令说明">
          解出其他口令不会增加奖励、报名资格或中奖机会。
        </Help>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <PasswordInput
          id="solve-password"
          label="验证其他口令"
          hideLabel
          compact
          value={password}
          onChange={setPassword}
          disabled={mutation.isPending || Boolean(pending)}
          onSubmit={() => void submit()}
          action={
            <button
              type="submit"
              className="button secondary"
              disabled={mutation.isPending || seconds > 0}
            >
              {mutation.isPending
                ? "正在确认…"
                : pending
                  ? "重试原提交"
                  : "验证口令"}
            </button>
          }
        />
        {message ? (
          <p role="status" className="form-message">
            {message}
          </p>
        ) : null}
        {seconds > 0 ? (
          <p role="timer" className="form-message">
            {seconds} 秒后可重试
          </p>
        ) : null}
      </form>
    </div>
  );
}
