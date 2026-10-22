import { amountToMinor, DRAND_QUICKNET, formatAmount } from "@hb/contracts";
import { useQuery } from "@tanstack/react-query";
import { Copy, Download } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  claimedCount,
  claimedInOrder,
  commitmentMatches,
  DRAND_NODES,
  type DrawData,
  drandRoundUrl,
  nodesAgree,
  proofKey,
  type QueueData,
  queueMatches,
  readProofData,
  resultMatches,
  rosterMatches,
  seedMatches,
} from "../../lib/draw-check";
import { splitOf } from "../../lib/hongbao-text";
import { clockSeconds } from "../../lib/roster-time";
import verifyScript from "../../lib/verify-draw.mjs?raw";
import {
  ProofOutcome,
  type ProofStep,
  roundText,
  StepList,
  useProofCheck,
} from "../hongbao/draw-proof";
import { InfoList, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { usePageTitle } from "../shell/use-page-title";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { MorphLabel } from "../ui/morph-label";
import { Reveal } from "../ui/reveal";
import { MessageView } from "./message-view";

// 🎲 开奖数据 (docs/draw-proof-design.md §5): everything that decided a v2
// 红包, the rule step by step, and the means to check it here or apart from
// this site. For whoever wants every detail; the same for everyone.

const ruleNames = { double_mean: "二倍均值", bounded_mean: "均值上下 50%" };
const ruleOf = (algorithm: string) => {
  const split = splitOf(algorithm);
  return split ? ruleNames[split] : algorithm;
};

/** A file the viewer saves, made here. */
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A whole hex value, wrapped, with its copy button. */
function FullHex({ value }: { value: string }) {
  return <span className="font-mono text-sm break-all">{value}</span>;
}

function Formula({ children }: { children: ReactNode }) {
  return (
    <code className="block rounded-lg bg-fill px-3 py-2 font-mono text-xs leading-relaxed text-ink-2 break-all whitespace-pre-wrap">
      {children}
    </code>
  );
}

function Steps({ items }: { items: { title: string; formula?: string }[] }) {
  return (
    <Panel className="p-5">
      <ol className="grid gap-4">
        {items.map((item, index) => (
          <li
            key={item.title}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5"
          >
            <span className="text-sm text-ink-3 tabular-nums">{index + 1}</span>
            <span className="text-sm text-ink">{item.title}</span>
            {item.formula && (
              <span className="col-start-2">
                <Formula>{item.formula}</Formula>
              </span>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** Rows in a quiet table: a header line, then one line each. */
function Table({
  head,
  rows,
  widths,
}: {
  head: string[];
  rows: ReactNode[][];
  widths: string;
}) {
  return (
    <Panel className="overflow-hidden">
      <div
        className="grid gap-x-3 border-line border-b px-4 py-2 text-xs text-ink-3"
        style={{ gridTemplateColumns: widths }}
      >
        {head.map((cell) => (
          <span key={cell}>{cell}</span>
        ))}
      </div>
      {rows.map((row, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no other key.
          key={index}
          className="grid items-baseline gap-x-3 border-line border-b px-4 py-2 text-sm last:border-b-0"
          style={{ gridTemplateColumns: widths }}
        >
          {row.map((cell, column) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells are fixed.
            <span key={column} className="min-w-0 truncate tabular-nums">
              {cell}
            </span>
          ))}
        </div>
      ))}
    </Panel>
  );
}

/** 复制验证脚本: the script itself, for a file of one's own. */
function CopyScript() {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <Button
      onClick={() => {
        const write = navigator.clipboard?.writeText(verifyScript);
        if (!write) return setState("failed");
        write.then(
          () => setState("done"),
          () => setState("failed"),
        );
      }}
    >
      <Copy />
      <MorphLabel>
        {state === "done"
          ? "已复制"
          : state === "failed"
            ? "请手动复制"
            : "复制验证脚本"}
      </MorphLabel>
    </Button>
  );
}

function VerifySection({
  steps,
  checks,
  success,
  data,
  name,
}: {
  steps: string[];
  checks: ProofStep[];
  success: string;
  data: DrawData | QueueData;
  /** The downloaded file's name. */
  name: string;
}) {
  const check = useProofCheck(steps.length);
  return (
    <PageSection
      title="自己验证"
      description="在浏览器里按上面的步骤重算一遍，逐项和公布的对照。不想相信本站页面上的代码，可以复制验证脚本，在自己的电脑上跑。"
    >
      <Panel className="grid gap-4 p-5">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => {
              if (!check.running) void check.run(async () => checks);
            }}
            aria-disabled={check.running || undefined}
          >
            {check.states === null ? "在浏览器里验证" : "再验证一次"}
          </Button>
          <CopyScript />
          <Button
            onClick={() =>
              download(
                name,
                `${JSON.stringify(data, null, 2)}\n`,
                "application/json",
              )
            }
          >
            <Download />
            下载全部数据
          </Button>
        </div>
        <p className="text-xs text-ink-3">
          验证脚本只用 Node 自带的库：
          <code className="ml-1 font-mono">node verify.mjs 数据.json</code>
        </p>
        <Reveal show={check.states !== null}>
          <div className="grid gap-3">
            <StepList steps={steps} states={check.states} />
            <ProofOutcome check={check} success={success} />
          </div>
        </Reveal>
      </Panel>
    </PageSection>
  );
}

function DrawPage({ data }: { data: DrawData }) {
  const [all, setAll] = useState(false);
  const { activity, drand, roster, result } = data;
  const { money } = activity;
  const registered = roster.entries.length;
  const winners = Math.min(registered, money.count);
  const entries = all ? roster.entries : roster.entries.slice(0, 10);
  const people = new Map(
    roster.entries.map((entry) => [entry.ordinal, entry.user.displayName]),
  );
  const waiting = <span className="text-ink-3">正在等待随机数</span>;
  usePageTitle(`开奖数据 · ${activity.title}`);
  return (
    <Page>
      <PageHeader
        eyebrow="🎲 开奖数据"
        title={activity.title}
        description={`${activity.author.displayName}的红包 · ${clockSeconds(Date.parse(activity.closedAt))} 截止 · 报名 ${registered} 人 · 抽 ${winners} 人 · 奖池 ${money.totalAmount} LDC`}
      />
      <PageSection
        title="随机数"
        description="drand quicknet 公开随机数：多家机构联合运行，Cloudflare 是其中之一，每 3 秒一轮，每轮带签名。"
      >
        <InfoList
          items={[
            {
              label: "轮次",
              value: roundText(drand.round),
              note: `${clockSeconds(Date.parse(drand.roundAt))} 产生；截止后的下一轮`,
            },
            {
              label: "随机值",
              value: drand.randomness ? (
                <FullHex value={drand.randomness} />
              ) : (
                waiting
              ),
              action: drand.randomness && (
                <CopyButton value={drand.randomness} label="随机值" />
              ),
            },
            {
              label: "签名",
              value: drand.signature ? (
                <FullHex value={drand.signature} />
              ) : (
                waiting
              ),
              action: drand.signature && (
                <CopyButton value={drand.signature} label="签名" />
              ),
            },
            {
              label: "链",
              value: <FullHex value={DRAND_QUICKNET.chainHash} />,
              action: (
                <CopyButton value={DRAND_QUICKNET.chainHash} label="链" />
              ),
            },
            {
              label: "查看原始数据",
              value: (
                <span className="flex flex-wrap gap-x-4 text-sm">
                  {DRAND_NODES.map((node, index) => (
                    <a
                      key={node}
                      href={drandRoundUrl(drand.round, node)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {index === 0 ? "Cloudflare 节点 ↗" : "drand 官方节点 ↗"}
                    </a>
                  ))}
                </span>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        title="报名名单"
        description="截止时冻结，按报名先后排好。名单哈希在截止时就推送出去。"
      >
        <div className="grid gap-3">
          <InfoList
            items={[
              {
                label: "名单哈希",
                value: <FullHex value={roster.hash} />,
                action: <CopyButton value={roster.hash} label="名单哈希" />,
              },
            ]}
          />
          {registered > 0 && (
            <Table
              head={["#", "报名的人", "报名编号", "报名时间"]}
              widths="2.25rem minmax(0,1fr) 6.5rem 5.5rem"
              rows={entries.map((entry) => [
                entry.ordinal,
                entry.user.displayName,
                <span
                  key="id"
                  className="font-mono text-xs"
                  title={entry.registrationId}
                >
                  {entry.registrationId.slice(0, 8)}…
                </span>,
                clockSeconds(Date.parse(entry.registeredAt)),
              ])}
            />
          )}
          <div className="flex flex-wrap gap-2">
            {registered > 10 && (
              <Button size="sm" onClick={() => setAll((value) => !value)}>
                {all ? "只看前 10 个" : `展开全部 ${registered} 人`}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() =>
                download(
                  "报名名单.csv",
                  `﻿序号,报名编号,用户名,报名时间\n${roster.entries
                    .map(
                      (entry) =>
                        `${entry.ordinal},${entry.registrationId},${entry.user.username},${entry.registeredAt}`,
                    )
                    .join("\n")}\n`,
                  "text/csv",
                )
              }
            >
              <Download />
              下载名单
            </Button>
          </div>
        </div>
      </PageSection>
      <PageSection
        title="算法：限时开奖 v2"
        description="哈希都是 SHA-256，文字按 UTF-8，各项之间用换行隔开。"
      >
        <Steps
          items={[
            {
              title: "名单哈希：每行“序号:报名编号”，按序号排好，用换行连起来",
              formula: 'SHA-256("1:<报名编号>\\n2:<报名编号>\\n…")',
            },
            {
              title: "种子",
              formula:
                'SHA-256("hb.lafi.sh/draw/v2\\n<红包编号>\\n<名单哈希>\\n<轮次>\\n<随机值>")',
            },
            {
              title: "随机字节：依次算下面这些，接成一条字节流",
              formula: 'SHA-256("<种子>:0")  SHA-256("<种子>:1")  …',
            },
            {
              title:
                "取整：取够位数的字节，按大端读成整数，超出范围就丢掉重取，不偏向任何结果",
            },
            {
              title: `抽中奖者：Floyd 抽样，从 1…${registered} 里抽 ${winners} 个序号`,
            },
            {
              title: `生成金额：${ruleOf(money.algorithm)}，${
                money.distributeFullPool ? winners : money.count
              } 份，合计 ${money.totalAmount}`,
            },
            { title: "分配：从金额里抽位置再洗牌，按序号从小到大对到中奖者" },
          ]}
        />
      </PageSection>
      <PageSection title="中间结果">
        {result ? (
          <div className="grid gap-3">
            <InfoList
              items={[
                {
                  label: "种子",
                  value: data.seed && <FullHex value={data.seed} />,
                  action: data.seed && (
                    <CopyButton value={data.seed} label="种子" />
                  ),
                },
                {
                  label: "抽到的序号",
                  value: (
                    <span className="tabular-nums">
                      {result.picked.join("、") || "无"}
                    </span>
                  ),
                  note: "按抽取的先后",
                },
                {
                  label: "生成的金额",
                  value: (
                    <span className="tabular-nums">
                      {result.amounts.map(formatAmount).join("、") || "无"}
                    </span>
                  ),
                },
              ]}
            />
            {result.winners.length > 0 && (
              <Table
                head={["#", "中奖的人", "LDC"]}
                widths="2.25rem minmax(0,1fr) 4.5rem"
                rows={result.winners.map((winner) => [
                  winner.ordinal,
                  people.get(winner.ordinal) ?? "",
                  formatAmount(winner.amountMinor),
                ])}
              />
            )}
          </div>
        ) : (
          <Panel className="p-5 text-sm text-ink-3">开奖后公开。</Panel>
        )}
      </PageSection>
      {result && (
        <VerifySection
          steps={[
            `从两个 drand 节点取 ${roundText(drand.round)}，两个节点给的一样`,
            `重算名单哈希（${registered} 人）`,
            "重算种子",
            "重算抽到的序号、金额和分配",
          ]}
          checks={[
            () => nodesAgree(data),
            () => rosterMatches(data),
            () => seedMatches(data),
            () => resultMatches(data),
          ]}
          success="重算出的名单哈希、种子、中奖者和金额，和公布的一样。"
          data={data}
          name="开奖数据.json"
        />
      )}
    </Page>
  );
}

function QueuePage({ data }: { data: QueueData }) {
  const { activity } = data;
  const { money } = activity;
  const random = money.mode === "random";
  const count = random ? money.count : money.amounts.length;
  const total = random
    ? money.totalAmount
    : formatAmount(
        money.amounts.reduce((sum, amount) => sum + amountToMinor(amount), 0),
      );
  const split = random
    ? `拼手气（${ruleOf(money.algorithm)}）`
    : "自定义金额（随机顺序）";
  usePageTitle(`发放数据 · ${activity.title}`);
  return (
    <Page>
      <PageHeader
        eyebrow="🎲 发放数据"
        title={activity.title}
        description={`${activity.author.displayName}的红包 · ${clockSeconds(Date.parse(activity.openedAt))} 开放 · ${split} · ${count} 份 · 总额 ${total} LDC`}
      />
      <PageSection
        title="封存"
        description="金额和顺序在开放时用种子定好；开放时公布种子的指纹（封存值），结束后公开种子。"
      >
        <InfoList
          items={[
            {
              label: "封存值",
              value: <FullHex value={data.commitment} />,
              note: `${clockSeconds(Date.parse(activity.openedAt))} 开放时公布`,
              action: <CopyButton value={data.commitment} label="封存值" />,
            },
            data.secret
              ? {
                  label: "种子",
                  value: <FullHex value={data.secret} />,
                  note: "结束时公开",
                  action: <CopyButton value={data.secret} label="种子" />,
                }
              : {
                  label: "种子",
                  value: <span className="text-ink-3">结束后公开</span>,
                },
          ]}
        />
      </PageSection>
      <PageSection
        title={random ? "算法：拼手气 v2" : "算法：随机顺序 v2"}
        description="哈希都是 SHA-256，文字按 UTF-8，各项之间用换行隔开。"
      >
        <Steps
          items={[
            {
              title: "封存值",
              formula: 'SHA-256("hb.lafi.sh/queue/v2\\n<红包编号>\\n<种子>")',
            },
            {
              title: "队列种子",
              formula:
                'SHA-256("hb.lafi.sh/queue/v2/seed\\n<红包编号>\\n<种子>")',
            },
            {
              title: "随机字节：依次算下面这些，接成一条字节流",
              formula: 'SHA-256("<队列种子>:0")  SHA-256("<队列种子>:1")  …',
            },
            random
              ? {
                  title: `生成金额：${ruleOf(money.algorithm)}，${count} 份，合计 ${total}`,
                }
              : { title: `金额：发红包的人填的 ${count} 份，合计 ${total}` },
            {
              title: random ? "洗牌，排成队列" : "按填写的顺序洗牌，排成队列",
            },
            { title: "第 k 个领取的人，拿队列里的第 k 份" },
          ]}
        />
      </PageSection>
      <PageSection title="队列和领取">
        {data.queue ? (
          <Table
            head={["位置", "LDC", "领到的人", "领取时间"]}
            widths="2.75rem 4.5rem minmax(0,1fr) 5.5rem"
            rows={data.queue.map((item) => [
              item.position + 1,
              formatAmount(item.amountMinor),
              item.claim?.user.displayName ?? (
                <span key="none" className="text-ink-3">
                  没人领
                </span>
              ),
              item.claim ? clockSeconds(Date.parse(item.claim.claimedAt)) : "",
            ])}
          />
        ) : (
          <Panel className="p-5 text-sm text-ink-3">结束后公开整个队列。</Panel>
        )}
      </PageSection>
      {data.secret && (
        <VerifySection
          steps={[
            "核对封存值",
            "重算金额和顺序",
            `对照每份领到的人（${claimedCount(data)} 人）`,
          ]}
          checks={[
            () => commitmentMatches(data),
            () => queueMatches(data),
            () => claimedInOrder(data),
          ]}
          success="种子对得上开放时公布的封存值，重算出的队列和每个人领到的一样。"
          data={data}
          name="发放数据.json"
        />
      )}
    </Page>
  );
}

/** 🎲 at /🧧/<编号>/🎲: open to anyone, signed in or not. */
export function DrawDataView({ id }: { id: string }) {
  const query = useQuery({
    queryKey: proofKey(id),
    queryFn: ({ signal }) => readProofData(id, signal),
    retry: false,
  });
  const data = query.data;
  return (
    <PageLoad load={queryLoad(query)}>
      {data?.kind === "draw" ? (
        <DrawPage data={data} />
      ) : data?.kind === "queue" ? (
        <QueuePage data={data} />
      ) : data?.kind === "pending" ? (
        <MessageView
          title="还没开奖"
          text="截止后用 drand 公开随机数开奖，开奖数据到时在这里公开。"
        />
      ) : data ? (
        <MessageView
          title="没有开奖数据"
          text="这个红包用的是旧算法，或者没有随机的部分。"
        />
      ) : null}
    </PageLoad>
  );
}
