import type { AdminJudgeFeature, JudgePage } from "@hb/contracts";
import { Link } from "@tanstack/react-router";
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

// 网站管理 · 判定器 · 精选 and 已撤下 (docs/judge-square-design.md §9,
// §15.4): the 站长精选 in order — 上移, 下移, 移出, 换成第 N 版 — and
// one more by its 编号 or address; those taken down, with 恢复.

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
  const look = async () => {
    if (looking) return;
    setError(null);
    setFound(null);
    const id = UUID.exec(address)?.[0];
    if (!id) {
      setError("没有这个判定器");
      return;
    }
    setLooking(true);
    try {
      const page = await fetchJudgePage(id);
      if (!page.listed) {
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
    <div className="grid gap-3 border-line border-t pt-4">
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
      {found && (
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
            选入
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function JudgeCuration() {
  const query = useJudgeCuration();
  const write = useJudgeCurationWrites();
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const data = query.data;
  if (!data) return null;
  const run = (action: JudgeCurationAction) => {
    if (write.isPending) return;
    setError(null);
    write.mutate(action, { onError: (failure) => setError(failed(failure)) });
  };
  const last = data.features.length - 1;
  return (
    <>
      <PageSection
        id="judge-features"
        title="精选"
        description="发红包第 2 步显示前 6 个。"
      >
        <Panel className="grid gap-0 px-4 pb-4">
          {data.features.length === 0 ? (
            <p className="py-4 text-sm text-ink-3">还没有精选的判定器。</p>
          ) : (
            <ol className="grid">
              {data.features.map((feature, index) => (
                <li
                  key={feature.judgeId}
                  className="grid gap-2 border-line border-b py-3 last:border-b-0"
                >
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
                      <Button
                        size="xs"
                        aria-disabled={
                          index === 0 || write.isPending || undefined
                        }
                        onClick={() => {
                          if (index > 0)
                            run({
                              kind: "move",
                              judgeId: feature.judgeId,
                              move: "up",
                            });
                        }}
                      >
                        上移
                      </Button>
                      <Button
                        size="xs"
                        aria-disabled={
                          index === last || write.isPending || undefined
                        }
                        onClick={() => {
                          if (index < last)
                            run({
                              kind: "move",
                              judgeId: feature.judgeId,
                              move: "down",
                            });
                        }}
                      >
                        下移
                      </Button>
                      <Button
                        size="xs"
                        aria-disabled={write.isPending || undefined}
                        onClick={() =>
                          run({ kind: "unfeature", judgeId: feature.judgeId })
                        }
                      >
                        移出
                      </Button>
                    </span>
                  </div>
                  {feature.newer !== null && (
                    <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
                      <span className="min-w-0 flex-1">
                        作者有第 {feature.newer} 版
                      </span>
                      <Button
                        size="xs"
                        aria-disabled={write.isPending || undefined}
                        onClick={() =>
                          run({
                            kind: "version",
                            judgeId: feature.judgeId,
                            n: feature.newer ?? feature.n,
                          })
                        }
                      >
                        换成第 {feature.newer} 版
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {error && (
            <p role="alert" className="pt-3 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="pt-4">
            <AddFeature />
          </div>
        </Panel>
      </PageSection>
      {data.takenDown.length > 0 && (
        <PageSection id="judge-taken-down" title="已撤下">
          <Panel as="ul" className="grid px-4">
            {data.takenDown.map((judge) => (
              <li
                key={judge.judgeId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-line border-b py-3 last:border-b-0"
              >
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
                <Button size="xs" onClick={() => setRestoring(judge.judgeId)}>
                  恢复
                </Button>
              </li>
            ))}
          </Panel>
        </PageSection>
      )}
      <RestoreDialog
        judgeId={restoring ?? ""}
        open={restoring !== null}
        onClose={() => setRestoring(null)}
      />
    </>
  );
}
