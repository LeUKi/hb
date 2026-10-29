import type {
  AdminJudgeCuration,
  AdminJudgeFeature,
  JudgePage,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { useId, useState } from "react";
import { ActivityRequestError, refused } from "../../../lib/activities";
import {
  type JudgeCurationAction,
  useJudgeCuration,
  useJudgeCurationWrites,
} from "../../../lib/admin";
import { fetchJudgePage, fetchMyJudge } from "../../../lib/judge";
import { fullTime } from "../../../lib/roster-time";
import { RestoreDialog } from "../../judges/curation-dialogs";
import { PageSection, Panel } from "../../page/page";
import { Button } from "../../ui/button";
import { Segmented, TextInput } from "../../ui/field";
import { ListItem, Reveal, Swap } from "../../ui/reveal";
import { DetailPart } from "./admin-frame";

// 网站管理 · 判定器 · 精选 and 已撤下 (docs/judge-square-design.md §9,
// §15.4): the 站长精选 in order — 上移, 下移, 移出, 换成第 N 版 — and
// one more by its 编号 or address; those taken down, with 恢复. While a
// change is on its way the pressed button says 正在保存… and the others
// wait; rows slide, open and close as the list changes.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const failed = (failure: unknown) =>
  refused(failure)
    ? failure.message
    : "保存没有完成：网络或服务出了问题。可以再试一次。";

/** 猜数字 · @作者 · 第 3 版 (· 基于 @作者 for the 站长's copy). */
function featureLine(feature: AdminJudgeFeature) {
  return [
    feature.name,
    `@${feature.author.username}`,
    `第 ${feature.n} 版`,
    feature.bySiteOwner && feature.basedOn ? `基于 @${feature.basedOn}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Whether `action` is the change on its way (its pressed button). */
const sameAction = (
  pending: JudgeCurationAction | undefined,
  action: JudgeCurationAction,
) =>
  pending !== undefined &&
  pending.kind === action.kind &&
  pending.judgeId === action.judgeId &&
  ("move" in pending ? pending.move : null) ===
    ("move" in action ? action.move : null);

/** 选入: find one by its 编号 or address, pick its version, put it in. */
function AddFeature() {
  const write = useJudgeCurationWrites();
  const inputId = useId();
  const [address, setAddress] = useState("");
  const [found, setFound] = useState<{
    page: JudgePage;
    versions: number[];
  } | null>(null);
  const [n, setN] = useState<number | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adding = write.isPending && write.variables?.kind === "feature";
  const look = async () => {
    if (looking) return;
    setError(null);
    const id = UUID.exec(address)?.[0];
    if (!id) {
      setFound(null);
      setError("没有这个判定器");
      return;
    }
    setLooking(true);
    try {
      const page = await fetchJudgePage(id);
      if (!page.listed) {
        setFound(null);
        setError("这个判定器不在判定器广场里");
        return;
      }
      // The 站长's own: any version that passed; another's: those that
      // opened a 红包.
      const versions = page.own
        ? (await fetchMyJudge(id)).versions
            .filter((version) => version.passed && version.protocol >= 3)
            .map((version) => version.n)
        : page.versions.map((version) => version.n);
      setFound({ page, versions });
      setN(versions[0] ?? null);
    } catch (failure) {
      setFound(null);
      setError(
        failure instanceof ActivityRequestError && failure.status === 404
          ? "没有这个判定器"
          : failed(failure),
      );
    } finally {
      setLooking(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 border-line border-t pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-60">
          <TextInput
            id={inputId}
            value={address}
            placeholder="判定器的编号或地址"
            aria-label="判定器的编号或地址"
            autoComplete="off"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void look();
            }}
          />
        </div>
        <Button
          size="sm"
          aria-disabled={looking || undefined}
          onClick={() => void look()}
        >
          {looking ? "正在查找…" : "查找"}
        </Button>
      </div>
      <Reveal show={Boolean(found)}>
        {found && (
          <Swap id={found.page.id}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 text-sm text-ink">
                {found.page.name} · @{found.page.author.username}
              </span>
              {found.versions.length > 0 && n !== null && (
                <Segmented
                  label="版本"
                  size="sm"
                  value={String(n)}
                  onChange={(value) => setN(Number(value))}
                  options={found.versions.map((version) => ({
                    value: String(version),
                    label: `第 ${version} 版`,
                  }))}
                />
              )}
              <Button
                variant="primary"
                size="sm"
                aria-disabled={write.isPending || n === null || undefined}
                data-disabled={(write.isPending && !adding) || undefined}
                onClick={() => {
                  if (write.isPending || n === null) return;
                  setError(null);
                  write.mutate(
                    { kind: "feature", judgeId: found.page.id, n },
                    {
                      onSuccess: () => {
                        setFound(null);
                        setAddress("");
                      },
                      onError: (failure) => setError(failed(failure)),
                    },
                  );
                }}
              >
                {adding ? "正在保存…" : "选入"}
              </Button>
            </div>
          </Swap>
        )}
      </Reveal>
      <Reveal show={Boolean(error)}>
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      </Reveal>
    </div>
  );
}

/** The 精选 rows in order, each with its changes. */
function Features({
  data,
  setError,
}: {
  data: AdminJudgeCuration;
  /** The failed change's line under the list (null as one starts). */
  setError: (message: string | null) => void;
}) {
  const write = useJudgeCurationWrites();
  const pending = write.isPending ? write.variables : undefined;
  const run = (action: JudgeCurationAction) => {
    if (write.isPending) return;
    setError(null);
    write.mutate(action, { onError: (failure) => setError(failed(failure)) });
  };
  /** A row's button: 正在保存… once pressed, the others waiting. */
  const press = (action: JudgeCurationAction, label: string, off = false) => {
    const mine = sameAction(pending, action);
    return (
      <Button
        size="xs"
        aria-disabled={off || write.isPending || undefined}
        data-disabled={(write.isPending && !mine) || undefined}
        onClick={() => {
          if (!off) run(action);
        }}
      >
        {mine ? "正在保存…" : label}
      </Button>
    );
  };
  const last = data.features.length - 1;
  if (data.features.length === 0)
    return <p className="py-4 text-sm text-ink-3">还没有精选的判定器。</p>;
  return (
    <ol className="flex flex-col">
      <AnimatePresence initial={false}>
        {data.features.map((feature, index) => (
          <ListItem
            key={feature.judgeId}
            layout
            className="border-line border-b last:border-b-0"
          >
            <div className="grid gap-2 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="min-w-0 flex-1 text-sm text-ink">
                  <Link
                    to="/judges/$judgeId"
                    params={{ judgeId: feature.judgeId }}
                    className="hover:underline"
                  >
                    {featureLine(feature)}
                  </Link>
                  {!feature.listed && (
                    <span className="text-ink-3">
                      （不在广场里，暂时不显示）
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 gap-1.5">
                  {press(
                    { kind: "move", judgeId: feature.judgeId, move: "up" },
                    "上移",
                    index === 0,
                  )}
                  {press(
                    { kind: "move", judgeId: feature.judgeId, move: "down" },
                    "下移",
                    index === last,
                  )}
                  {press(
                    { kind: "unfeature", judgeId: feature.judgeId },
                    "移出",
                  )}
                </span>
              </div>
              {feature.newer !== null && (
                <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
                  <span className="min-w-0 flex-1">
                    作者有第 {feature.newer} 版
                  </span>
                  {press(
                    {
                      kind: "version",
                      judgeId: feature.judgeId,
                      n: feature.newer,
                    },
                    `换成第 ${feature.newer} 版`,
                  )}
                </div>
              )}
            </div>
          </ListItem>
        ))}
      </AnimatePresence>
    </ol>
  );
}

export function JudgeCuration() {
  const query = useJudgeCuration();
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const data = query.data;
  const takenDown = data?.takenDown ?? [];
  return (
    <>
      <PageSection
        id="judge-features"
        title="精选"
        description="发红包第 2 步显示前 6 个。"
      >
        <Panel className="flex flex-col px-4 pb-4">
          {/* Its frame from the start: bars while it reads, then the list. */}
          <Swap id={data ? "list" : query.isError ? "failed" : "loading"}>
            {data ? (
              <Features data={data} setError={setError} />
            ) : (
              <div className="pt-4">
                <DetailPart query={query} lines={3} what="精选">
                  {() => null}
                </DetailPart>
              </div>
            )}
          </Swap>
          <Reveal show={Boolean(error)}>
            <p role="alert" className="pt-3 text-sm text-danger">
              {error}
            </p>
          </Reveal>
          {data && (
            <div className="pt-4">
              <AddFeature />
            </div>
          )}
        </Panel>
      </PageSection>
      <Reveal show={takenDown.length > 0}>
        <PageSection id="judge-taken-down" title="已撤下">
          <Panel as="ul" className="flex flex-col px-4">
            <AnimatePresence initial={false}>
              {takenDown.map((judge) => (
                <ListItem
                  key={judge.judgeId}
                  className="border-line border-b last:border-b-0"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <Link
                        to="/judges/$judgeId"
                        params={{ judgeId: judge.judgeId }}
                        className="text-sm text-ink hover:underline"
                      >
                        {judge.name} · @{judge.author.username}
                      </Link>
                      <span className="text-xs text-ink-3">
                        原因：{judge.reason} · {fullTime(Date.parse(judge.at))}
                      </span>
                    </span>
                    <Button
                      size="xs"
                      onClick={() => setRestoring(judge.judgeId)}
                    >
                      恢复
                    </Button>
                  </div>
                </ListItem>
              ))}
            </AnimatePresence>
          </Panel>
        </PageSection>
      </Reveal>
      <RestoreDialog
        judgeId={restoring ?? ""}
        open={restoring !== null}
        onClose={() => setRestoring(null)}
      />
    </>
  );
}
