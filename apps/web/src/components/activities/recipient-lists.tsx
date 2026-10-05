import { paymentLabel, type RegistrationStatus } from "@hb/contracts";
import { useState } from "react";
import { formatTime } from "../../lib/activities";
import {
  useAuthorClaims,
  useAuthorRegistrations,
  usePublicRecipients,
} from "../../lib/claims";
import { Button } from "../ui/button";
import { UserIdentity } from "../user-identity";
import { ActivityErrorView } from "./activity-error";

function Pagination({
  cursors,
  setCursors,
  nextCursor,
}: {
  cursors: Array<string | null>;
  setCursors: (value: Array<string | null>) => void;
  nextCursor: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={cursors.length === 1}
        onClick={() => setCursors(cursors.slice(0, -1))}
      >
        上一页
      </Button>
      <span className="text-sm text-neutral-500">第 {cursors.length} 页</span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={!nextCursor}
        onClick={() => {
          if (nextCursor) setCursors([...cursors, nextCursor]);
        }}
      >
        下一页
      </Button>
    </div>
  );
}

export function PublicRecipients({
  id,
  enabled,
}: {
  id: string;
  enabled: boolean;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = usePublicRecipients(id, cursors.at(-1) ?? null, enabled);
  if (!enabled || (!query.isError && query.data?.enabled === false))
    return null;
  return (
    <section
      className="space-y-4 border-t border-neutral-200 pt-5"
      aria-label="领取名单"
    >
      <h2 className="font-semibold">领取名单</h2>
      {query.isPending ? (
        <p role="status" className="text-sm">
          正在读取领取名单…
        </p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            <ul className="divide-y divide-neutral-200 text-sm">
              {query.data.items.map((recipient) => (
                <li
                  key={recipient.id}
                  className="flex flex-wrap justify-between gap-2 py-3"
                >
                  <UserIdentity profile={recipient} />
                  {recipient.claimedAt ? (
                    <time
                      className="text-neutral-500"
                      dateTime={recipient.claimedAt}
                    >
                      {formatTime(recipient.claimedAt)}
                    </time>
                  ) : null}
                  {recipient.amount !== undefined ? (
                    <span>{recipient.amount} LDC</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">暂无领取记录。</p>
          )}
          {query.data.nextCursor || cursors.length > 1 ? (
            <Pagination
              cursors={cursors}
              setCursors={setCursors}
              nextCursor={query.data.nextCursor}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

export function AuthorClaims({ id, userId }: { id: string; userId: string }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useAuthorClaims(userId, id, cursors.at(-1) ?? null);
  return (
    <section className="activity-panel space-y-4" aria-label="活动领取记录">
      <h2 className="text-lg font-semibold">活动领取记录</h2>
      {query.isPending ? (
        <p role="status">正在读取领取记录…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            <ul className="divide-y divide-neutral-200">
              {query.data.items.map((claim) => (
                <li key={claim.id} className="space-y-3 py-3">
                  <div className="flex flex-wrap justify-between gap-2 text-sm">
                    <UserIdentity profile={claim.claimant} />
                    <time
                      dateTime={claim.claimedAt}
                      className="text-neutral-500"
                    >
                      {formatTime(claim.claimedAt)}
                    </time>
                  </div>
                  {claim.rewardType === "text" ? (
                    <details className="text-sm">
                      <summary className="cursor-pointer">
                        查看已分配文本
                      </summary>
                      <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-neutral-50 p-3 [overflow-wrap:anywhere]">
                        {claim.text}
                      </pre>
                    </details>
                  ) : (
                    <p className="text-sm">
                      {claim.amount} LDC ·{" "}
                      {paymentLabel(claim.payment.mode, claim.payment.status)}
                      {claim.payment.mode === "simulation" ? " · 本地模拟" : ""}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">暂无领取记录。</p>
          )}
          {query.data.nextCursor || cursors.length > 1 ? (
            <Pagination
              cursors={cursors}
              setCursors={setCursors}
              nextCursor={query.data.nextCursor}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

const registrationLabels: Record<RegistrationStatus, string> = {
  registered: "已报名",
  drawing: "开奖处理中",
  won: "已中奖",
  not_won: "未中奖",
};

export function AuthorRegistrations({
  id,
  userId,
}: {
  id: string;
  userId: string;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useAuthorRegistrations(userId, id, cursors.at(-1) ?? null);
  return (
    <section className="activity-panel space-y-4" aria-label="活动报名记录">
      <h2 className="text-lg font-semibold">活动报名记录</h2>
      {query.isPending ? (
        <p role="status">正在读取报名记录…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            <ul className="divide-y divide-neutral-200">
              {query.data.items.map((registration) => (
                <li key={registration.id} className="space-y-2 py-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <UserIdentity profile={registration.participant} />
                    <time
                      dateTime={registration.registeredAt}
                      className="text-neutral-500"
                    >
                      {formatTime(registration.registeredAt)}
                    </time>
                  </div>
                  <p>
                    {registrationLabels[registration.status]} · 开奖时间：
                    {formatTime(registration.drawAt)}
                  </p>
                  {registration.claim ? (
                    <p>
                      已生成奖励记录：
                      {registration.claim.rewardType === "ldc" ? "LDC" : "文本"}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">暂无报名记录。</p>
          )}
          {query.data.nextCursor || cursors.length > 1 ? (
            <Pagination
              cursors={cursors}
              setCursors={setCursors}
              nextCursor={query.data.nextCursor}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
