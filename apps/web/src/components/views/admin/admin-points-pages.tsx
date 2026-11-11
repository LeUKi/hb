// One 三方积分's own pages in 网站管理 (docs/third-party-points-design.md
// §7): 配置 (every setting, each word as it renders), 文案改动 (before and
// after, unseen marked, 都看过了) and 接口测试记录 (each run and its steps).
// One level down from the list, each with its way back to the row it came
// from (/admin/points?id=). 发放记录 is points-records.tsx, shared with the
// issuer.
import type { ReactNode } from "react";
import {
  type AdminPointsDetail,
  type PointsCopy,
  useAdminPointsActions,
  useAdminPointsDetail,
} from "../../../lib/points";
import { clockLabel } from "../../../lib/roster-time";
import { amountText } from "../../../lib/units";
import {
  EmptyNote,
  InfoList,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../../page/page";
import { PageLoad, queryLoad } from "../../page/page-state";
import { Button } from "../../ui/button";
import { NoteMarkdown } from "../../ui/markdown";
import { PointsCapsule } from "../../ui/points-mark";
import { StatusChip } from "../../ui/status-chip";

/** The words an issuer writes (§6), in the 设置页's order. */
const copyFields = [
  ["intro", "介绍"],
  ["keyGuide", "怎么拿到密钥"],
  ["noRecipient", "领取的人还没开户时"],
  ["arrival", "到账后"],
  ["notAllowed", "不能发给他时"],
  ["insufficient", "余额不够时"],
  ["keyInvalid", "密钥失效时"],
] as const satisfies readonly (readonly [keyof PointsCopy, string])[];

const fieldWords: Record<string, string> = {
  name: "名称",
  unit: "单位",
  issuerName: "网站名称",
  baseUrl: "接口地址",
  step: "最小单位",
  rate: "每秒最多调用",
  ...Object.fromEntries(copyFields),
};

/** A page of one system: its header with the way back, then `children`. */
function SystemPage({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: (detail: AdminPointsDetail) => ReactNode;
  children: (detail: AdminPointsDetail) => ReactNode;
}) {
  const query = useAdminPointsDetail(id);
  const detail = query.data;
  return (
    <PageLoad load={queryLoad(query)}>
      {detail && (
        <Page>
          <PageHeader
            back={{
              label: "三方积分",
              href: `/admin/points?id=${encodeURIComponent(id)}`,
            }}
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <PointsCapsule name={detail.system.name} />
                {title}
              </span>
            }
            description={description ?? detail.system.issuerName}
            actions={actions?.(detail)}
            refreshable
          />
          {children(detail)}
        </Page>
      )}
    </PageLoad>
  );
}

export function AdminPointsConfig({ id }: { id: string }) {
  return (
    <SystemPage id={id} title="配置">
      {({ system }) => {
        const unit = { unit: system.unit, step: system.step };
        return (
          <>
            <InfoList
              items={[
                { label: "名称", value: system.name },
                { label: "单位", value: system.unit },
                { label: "最小单位", value: amountText(system.step, unit) },
                { label: "网站名称", value: system.issuerName },
                { label: "接口地址", value: system.baseUrl },
                { label: "每秒最多调用", value: `${system.rate} 次` },
                { label: "添加的人", value: `@${system.ownerUsername}` },
                {
                  label: "接口测试",
                  value: system.passed
                    ? "当前接口地址已通过"
                    : "当前接口地址没通过",
                },
                {
                  label: "提交审核",
                  value: system.submittedAt
                    ? clockLabel(system.submittedAt)
                    : "—",
                },
                {
                  label: "上线",
                  value: system.onlineAt ? clockLabel(system.onlineAt) : "—",
                },
                { label: "审核意见", value: system.reviewNote || "—" },
              ]}
            />
            <PageSection
              title="说明文字"
              description="发行方写的，按它们在页面上的样子显示。"
            >
              <InfoList
                items={copyFields.map(([key, label]) => ({
                  label,
                  value: system[key] ? (
                    <NoteMarkdown className="text-sm">
                      {system[key]}
                    </NoteMarkdown>
                  ) : (
                    <span className="text-sm text-ink-3">
                      没写，用本站的默认说法
                    </span>
                  ),
                }))}
              />
            </PageSection>
          </>
        );
      }}
    </SystemPage>
  );
}

export function AdminPointsChanges({ id }: { id: string }) {
  const actions = useAdminPointsActions();
  return (
    <SystemPage
      id={id}
      title="文案改动"
      description="提交审核以后，发行方每改一处就记一条。没看过的标红点。"
      actions={(detail) =>
        detail.changes.some((change) => change.seenAt === null) ? (
          <Button
            aria-disabled={actions.seen.isPending || undefined}
            onClick={() => {
              if (!actions.seen.isPending) actions.seen.mutate(id);
            }}
          >
            {actions.seen.isPending ? "正在标记…" : "都看过了"}
          </Button>
        ) : undefined
      }
    >
      {({ changes }) =>
        changes.length === 0 ? (
          <EmptyNote title="还没有改动" text="提交审核以后还没改过。" />
        ) : (
          <Panel className="grid px-4">
            {changes.map((change) => (
              <div
                key={change.id}
                className="grid gap-1 border-line border-b py-3 text-sm last:border-b-0"
              >
                <span className="flex flex-wrap items-center gap-2 text-ink">
                  <b className="font-medium">
                    {fieldWords[change.field] ?? change.field}
                  </b>
                  {change.seenAt === null && (
                    <StatusChip tone="danger" dot>
                      没看过
                    </StatusChip>
                  )}
                  <span className="ml-auto text-xs text-ink-3">
                    @{change.username} · {clockLabel(change.createdAt)}
                  </span>
                </span>
                <span className="break-all text-ink-3 line-through">
                  {change.before || "（空）"}
                </span>
                <span className="break-all text-ink-2">
                  {change.after || "（空）"}
                </span>
              </div>
            ))}
          </Panel>
        )
      }
    </SystemPage>
  );
}

export function AdminPointsTests({ id }: { id: string }) {
  return (
    <SystemPage
      id={id}
      title="接口测试记录"
      description="发行方在设置页跑的接口测试，最近的在前。"
    >
      {({ tests }) =>
        tests.length === 0 ? (
          <EmptyNote
            title="还没跑过接口测试"
            text="发行方跑过以后会列在这里。"
          />
        ) : (
          <div className="grid gap-3">
            {tests.map((test) => (
              <Panel key={test.id} className="grid gap-2 p-4 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <b className="font-medium text-ink">
                    {clockLabel(test.startedAt)}
                  </b>
                  <StatusChip
                    tone={
                      test.status === "passed"
                        ? "success"
                        : test.status === "failed"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {test.status === "passed"
                      ? "全部通过"
                      : test.status === "failed"
                        ? `停在第 ${test.steps.at(-1)?.n ?? "?"} 步`
                        : "进行中"}
                  </StatusChip>
                  <span className="min-w-0 truncate text-xs text-ink-3">
                    {test.baseUrl}
                  </span>
                </span>
                <ol className="grid gap-1">
                  {test.steps.map((step) => (
                    <li key={step.n} className="grid gap-0.5">
                      <span className="flex items-center gap-2">
                        <span
                          className={step.ok ? "text-success" : "text-danger"}
                        >
                          {step.ok ? "✓" : "✗"}
                        </span>
                        <span className="text-ink">
                          {step.n}. {step.title}
                        </span>
                        <span className="ml-auto text-xs text-ink-3">
                          {step.ms} ms
                        </span>
                      </span>
                      {!step.ok && (
                        <span className="pl-5 font-mono text-xs break-all text-ink-3">
                          {step.note ?? step.got}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </Panel>
            ))}
          </div>
        )
      }
    </SystemPage>
  );
}
