import { RefreshCw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { encodeActivityEmoji } from "../../src/lib/ecoji-v2";
import { parseActivityLink } from "../../src/lib/emoji-links";
import { CompactIconButton } from "../components/compact-icon-button";
import { normalizePrototypeTopicLink } from "../topic-link";
import type { Identity } from "../types";
import { PageTitle } from "./workbench-ui";
import "./admin.css";

type Section =
  | "overview"
  | "activities"
  | "users"
  | "payments"
  | "settings"
  | "audit";

const sections: Array<[Section, string]> = [
  ["overview", "概览"],
  ["activities", "活动"],
  ["users", "用户"],
  ["payments", "付款"],
  ["settings", "网站设置"],
  ["audit", "操作记录"],
];

type RecordRow = {
  id: string;
  name: string;
  status: string;
  type: string;
  at: number;
  fields: Array<[string, string]>;
  meta?: {
    activityId?: string;
    emojiCode?: string;
    topicId?: string;
    postNumber?: number;
    drawAnomaly?: string;
    paymentAnomaly?: string;
    taskId?: string;
    businessNo?: string;
    externalNo?: string;
    merchantId?: string;
    recipientId?: string;
    username?: string;
    displayName?: string;
    linuxDoId?: string;
    userId?: string;
    operator?: string;
    date?: string;
  };
};

type Route = ReturnType<typeof readRoute>;
type ReadMode = "ready" | "error";
type ReadState = {
  busy: boolean;
  error: string;
  lastSuccessAt: number;
};

const now = Date.now();
const topicSamples = [
  ["2964597", 1216],
  ["12345", 1],
  ["12345", 7],
  ["45678", 3],
] as const;

function activityIdAt(index: number) {
  return `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function optionValues(rows: RecordRow[], pick: (row: RecordRow) => string) {
  return [...new Set(rows.map(pick).filter(Boolean))];
}

function toDateInput(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}

const records: Record<
  "activities" | "users" | "payments" | "audit",
  RecordRow[]
> = {
  activities: Array.from({ length: 25 }, (_, i) => {
    const id = activityIdAt(i);
    const emojiCode = encodeActivityEmoji(id);
    const topic = topicSamples[i % topicSamples.length] ?? topicSamples[0];
    const draw = i % 3 === 2;
    const drawAnomaly = draw && i % 8 === 0 ? "结算等待超过十分钟" : "";
    const authorUsername = `demo${i % 6}`;
    const status = ["草稿", "进行中", "已结束", "归档"][i % 4] ?? "草稿";
    const type = "LDC";
    return {
      id,
      name: `活动样例 ${i + 1}`,
      status,
      type,
      at: now - i * 60_000,
      fields: [
        ["活动 UUID", id],
        ["作者", `${authorUsername} · Linux DO ${332940 + (i % 6)}`],
        ["奖励方式", draw ? "限时开奖" : i % 3 === 1 ? "即时随机" : "固定均分"],
        ["生命周期", status],
        ["参与方式", i % 2 ? "口令参与" : "直接参与"],
        ["库存", "20 份，已领取 3 份"],
        ["报名人数", String(12 + (i % 5))],
        ["开奖状态", drawAnomaly || (draw ? "等待开奖" : "不适用")],
        ["Emoji 活动码", emojiCode],
        ["关联帖子", `https://linux.do/t/topic/${topic[0]}/${topic[1]}`],
        ["关联付款", `${(i % 4) + 1} 笔；未确认 ${i % 2} 笔`],
      ],
      meta: {
        activityId: id,
        emojiCode,
        topicId: topic[0],
        postNumber: topic[1],
        drawAnomaly,
        username: authorUsername,
      },
    };
  }),
  users: Array.from({ length: 25 }, (_, i) => ({
    id: `demo-user-${i}`,
    name: `示例用户 ${i + 1}`,
    status: i % 7 ? "可用" : "不可用",
    type: i % 3 ? "普通" : "青春版",
    at: now - i * 60_000,
    fields: [
      ["用户名", `demo${i}`],
      ["显示名称", `示例用户 ${i + 1}`],
      ["Linux DO ID", String(332940 + i)],
      ["本站用户 ID", `demo-user-${i}`],
      ["账号状态", i % 7 ? "可用 · 可登录" : "不可用 · 已停用"],
      ["永久账号资格", i % 3 ? "官方 Connect 已验证" : "青春版"],
      [
        "注册时间",
        new Date(now - (i + 20) * 86_400_000).toLocaleString("zh-CN"),
      ],
      ["最近登录", new Date(now - i * 300_000).toLocaleString("zh-CN")],
      ["发起活动 / 领取 / 报名 / 商户", "3 / 12 / 5 / 1"],
    ],
    meta: {
      userId: `demo-user-${i}`,
      username: `demo${i}`,
      displayName: `示例用户 ${i + 1}`,
      linuxDoId: String(332940 + i),
      recipientId: `demo-user-${i}`,
    },
  })),
  payments: Array.from({ length: 25 }, (_, i) => {
    const activityId = activityIdAt(i % 10);
    const merchantId = `demo-merchant-${(i % 4) + 1}`;
    const recipientId = `demo-user-${i % 6}`;
    const status =
      ["待发送", "发送中", "结果未知", "需要关注", "已确认"][i % 5] ?? "待发送";
    const paymentAnomaly =
      i % 6 === 0
        ? "未投递超过十分钟"
        : status === "结果未知"
          ? "结果未知"
          : status === "需要关注"
            ? "需要关注"
            : i % 7 === 0
              ? "等待超过一小时"
              : "";
    const taskId = `task-${String(i).padStart(4, "0")}`;
    const businessNo = `BIZ-20261012-${String(i).padStart(6, "0")}`;
    const externalNo = `DEMO-EXTERNAL-${String(i).padStart(20, "0")}`;
    return {
      id: `demo-payment-${i}`,
      name: `订单 DEMO-20261012-${String(i).padStart(8, "0")}`,
      status,
      type: i % 2 ? "模拟" : "真实",
      at: now - i * 60_000,
      fields: [
        ["金额", "12.34 LDC"],
        ["活动 UUID", activityId],
        ["活动", `活动样例 ${(i % 10) + 1}`],
        ["商户 ID", merchantId],
        ["稳定收款人 ID", recipientId],
        ["订单用户名快照", `demo${i % 6}`],
        ["当前用户名", `demo${i % 6}_new`],
        ["任务 ID", taskId],
        ["业务号", businessNo],
        ["外部交易号", externalNo],
        ["阻塞原因", status === "需要关注" ? "需要核对订单证据" : "—"],
        ["异常", paymentAnomaly || "—"],
        [
          "订单证据",
          status === "已确认" ? "本站已保存确认结果" : "暂无确认结果",
        ],
        ["发送 / 查单次数", "1 / 2"],
        ["下次计划时间", new Date(now + 60_000).toLocaleString("zh-CN")],
        ["尝试记录", "第 1 页：查单 · 结果未确认；发送 · 已受理"],
      ],
      meta: {
        activityId,
        emojiCode: encodeActivityEmoji(activityId),
        paymentAnomaly,
        taskId,
        businessNo,
        externalNo,
        merchantId,
        recipientId,
      },
    };
  }),
  audit: Array.from({ length: 25 }, (_, i) => {
    const at = now - i * 60_000;
    const operator = i % 3 === 0 ? "示例管理员" : "运营管理员";
    return {
      id: `demo-change-${i}`,
      name: i % 2 ? "参与尝试限流" : "登录方式",
      status: operator,
      type: i % 2 ? "尝试间隔" : "登录开关",
      at,
      fields: [
        ["操作者", operator],
        ["前值", i % 2 ? "首页 5 秒；活动页 2 秒" : "允许 LiteAUTH 登录"],
        ["后值", i % 2 ? "首页 10 秒；活动页 3 秒" : "关闭 LiteAUTH 登录"],
        ["修改时间", new Date(at).toLocaleString("zh-CN")],
      ],
      meta: { operator, date: toDateInput(at) },
    };
  }),
};

let savedSettings = { lite: true, home: "5", activity: "2", updatedAt: now };

function readState(time = Date.now()): ReadState {
  return { busy: false, error: "", lastSuccessAt: time };
}

function formatReadTime(time: number) {
  return new Date(time).toLocaleString("zh-CN");
}

function readRoute() {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  if (q.get("section") === "activities" && q.has("type")) {
    q.delete("type");
    q.delete("page");
    q.delete("cursor");
    window.history.replaceState(null, "", `#admin?${q}`);
  }
  return {
    section: (q.get("section") ?? "overview") as Section,
    q: q.get("q") ?? "",
    type: q.get("type") ?? "",
    status: q.get("status") ?? "",
    anomaly: q.get("anomaly") ?? "",
    activity: q.get("activity") ?? "",
    merchant: q.get("merchant") ?? "",
    recipient: q.get("recipient") ?? "",
    operator: q.get("operator") ?? "",
    from: q.get("from") ?? "",
    to: q.get("to") ?? "",
    page: Math.max(1, Number(q.get("page")) || 1),
    detail: q.get("detail") ?? "",
  };
}

function parseActivitySearch(value: string) {
  const input = value.trim();
  if (!input) return "";
  return parseActivityLink(input, window.location.origin) ?? input;
}

function topicMatches(row: RecordRow, value: string) {
  const topic = normalizePrototypeTopicLink(value);
  return (
    Boolean(topic) &&
    row.meta?.topicId === topic?.topicId &&
    row.meta?.postNumber === topic?.postNumber
  );
}

function rowMatchesSearch(section: Section, row: RecordRow, query: string) {
  const input = query.trim();
  if (!input) return true;
  if (section === "activities") {
    const activityId = parseActivitySearch(input);
    if (activityId !== input) return row.id === activityId;
    if (topicMatches(row, input)) return true;
    return (
      row.name.includes(input) ||
      row.id === input ||
      row.meta?.username === input
    );
  }
  if (section === "payments") {
    const activityId = parseActivitySearch(input);
    if (activityId !== input) return row.meta?.activityId === activityId;
    return (
      row.name.includes(input) ||
      row.id === input ||
      row.meta?.taskId === input ||
      row.meta?.businessNo === input ||
      row.meta?.externalNo === input
    );
  }
  if (section === "users") {
    return (
      row.name.includes(input) ||
      row.meta?.displayName?.includes(input) ||
      row.meta?.username === input ||
      row.meta?.linuxDoId === input ||
      row.meta?.userId === input
    );
  }
  if (section === "audit") {
    return row.name.includes(input) || row.id === input;
  }
  return true;
}

function rowMatchesRoute(section: Section, row: RecordRow, route: Route) {
  if (!rowMatchesSearch(section, row, route.q)) return false;
  if (route.type && row.type !== route.type) return false;
  if (route.status && row.status !== route.status) return false;
  if (section === "activities") {
    if (route.anomaly && row.meta?.drawAnomaly !== route.anomaly) return false;
  }
  if (section === "payments") {
    const activityId = parseActivitySearch(route.activity);
    if (route.activity && row.meta?.activityId !== activityId) return false;
    if (route.merchant && row.meta?.merchantId !== route.merchant) return false;
    if (route.recipient && row.meta?.recipientId !== route.recipient)
      return false;
    if (route.anomaly && row.meta?.paymentAnomaly !== route.anomaly)
      return false;
  }
  if (section === "audit") {
    if (
      route.operator &&
      !row.meta?.operator?.toLowerCase().includes(route.operator.toLowerCase())
    )
      return false;
    if (route.from && (row.meta?.date ?? "") < route.from) return false;
    if (route.to && (row.meta?.date ?? "") > route.to) return false;
  }
  return true;
}

export function AdminPrototype({ identity }: { identity: Identity }) {
  const [route, setRoute] = useState(readRoute);
  const [search, setSearch] = useState(route.q);
  const [readMode, setReadMode] = useState<ReadMode>("ready");
  const [listRead, setListRead] = useState(() => readState());
  const [draft, setDraft] = useState(savedSettings);
  const [message, setMessage] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const readModeRef = useRef(readMode);
  const listReadRequest = useRef<number | null>(null);
  const dirty =
    draft.lite !== savedSettings.lite ||
    draft.home !== savedSettings.home ||
    draft.activity !== savedSettings.activity;

  readModeRef.current = readMode;

  useEffect(() => {
    const read = () => {
      const next = readRoute();
      setRoute(next);
      setSearch(next.q);
    };
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, []);

  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);

  useEffect(
    () => () => {
      if (listReadRequest.current !== null)
        window.clearTimeout(listReadRequest.current);
    },
    [],
  );

  function update(next: Partial<Route>) {
    if (
      route.section === "settings" &&
      next.section &&
      next.section !== "settings" &&
      dirty
    ) {
      if (!window.confirm("还有未保存的配置，确定离开吗？")) return;
      setDraft(savedSettings);
    }
    const value = { ...route, ...next };
    const q = new URLSearchParams();
    for (const [key, item] of Object.entries(value))
      if (item && !(key === "page" && item === 1)) q.set(key, String(item));
    window.history.pushState(null, "", `#admin?${q}`);
    setRoute(value);
    setSearch(value.q);
  }

  const refresh = useCallback(
    (source: "manual" | "background" = "manual") => {
      if (
        source === "manual" &&
        route.section === "settings" &&
        dirty &&
        !window.confirm("刷新会放弃未保存的修改，是否继续？")
      )
        return;
      if (listReadRequest.current !== null) return;
      if (route.section === "settings" && source === "manual")
        setDraft(savedSettings);
      setListRead((old) => ({ ...old, busy: true }));
      listReadRequest.current = window.setTimeout(() => {
        listReadRequest.current = null;
        if (readModeRef.current === "error") {
          setListRead((old) => ({
            ...old,
            busy: false,
            error: "读取失败，请重试。",
          }));
          return;
        }
        const successAt = Date.now();
        setListRead({ busy: false, error: "", lastSuccessAt: successAt });
        if (source === "manual")
          setMessage(
            route.section === "settings" ? "设置内容已刷新。" : "内容已刷新。",
          );
      }, 180);
    },
    [dirty, route.section],
  );

  useEffect(() => {
    if (route.section !== "overview") return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh("background");
    }, 30_000);
    return () => clearInterval(timer);
  }, [route.section, refresh]);

  if (identity !== "standard")
    return (
      <section className="work-page">
        <h1>网站管理</h1>
        <p role="alert">此页面仅限管理员访问</p>
      </section>
    );

  const section = sections.some(([s]) => s === route.section)
    ? route.section
    : "overview";
  const sectionRows =
    section === "activities" ||
    section === "users" ||
    section === "payments" ||
    section === "audit"
      ? records[section]
      : [];
  const items = sectionRows.filter((row) =>
    rowMatchesRoute(section, row, route),
  );
  const selected = sectionRows.find((row) => row.id === route.detail);
  const types = optionValues(sectionRows, (row) => row.type);
  const statuses = optionValues(sectionRows, (row) => row.status);
  const anomalies =
    section === "activities"
      ? optionValues(sectionRows, (row) => row.meta?.drawAnomaly ?? "")
      : section === "payments"
        ? optionValues(sectionRows, (row) => row.meta?.paymentAnomaly ?? "")
        : [];
  const merchants = optionValues(
    records.payments,
    (row) => row.meta?.merchantId ?? "",
  );
  const recipients = optionValues(
    records.payments,
    (row) => row.meta?.recipientId ?? "",
  );

  return (
    <section className="work-page prototype-admin">
      <PageTitle title="网站管理" />
      <nav className="prototype-admin-nav" aria-label="管理模块">
        {sections.map(([value, label]) => (
          <a
            key={value}
            href={`#admin?section=${value}`}
            aria-current={section === value ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              update({
                section: value,
                page: 1,
                q: "",
                type: "",
                status: "",
                anomaly: "",
                activity: "",
                merchant: "",
                recipient: "",
                operator: "",
                from: "",
                to: "",
                detail: "",
              });
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <header className="prototype-admin-heading">
        <h2>{sections.find(([s]) => s === section)?.[1]}</h2>
        <div className="prototype-admin-toolbar">
          <label className="prototype-admin-read-mode">
            读取演示
            <select
              value={readMode}
              onChange={(event) => setReadMode(event.target.value as ReadMode)}
            >
              <option value="ready">正常</option>
              <option value="error">读取失败</option>
            </select>
          </label>
          <CompactIconButton
            aria-label="刷新"
            title="刷新"
            disabled={listRead.busy}
            onClick={() => refresh()}
          >
            <RefreshCw
              size={16}
              className={listRead.busy ? "spin" : undefined}
            />
          </CompactIconButton>
        </div>
      </header>
      <p className="text-sm text-subtle">
        上次成功读取：{formatReadTime(listRead.lastSuccessAt)} · 本地样例
      </p>
      {listRead.error ? (
        <p className="prototype-admin-read-error" role="alert">
          {listRead.error}上次成功读取：{formatReadTime(listRead.lastSuccessAt)}
        </p>
      ) : null}
      {section === "overview" ? (
        <>
          <div className="prototype-admin-metrics">
            {[
              ["未确认付款", "3", "payments", "", "结果未知"],
              ["需要关注", "2", "payments", "", "需要关注"],
              ["付款等待超过一小时", "1", "payments", "", "等待超过一小时"],
              [
                "开奖结算超过十分钟",
                "4",
                "activities",
                "",
                "结算等待超过十分钟",
              ],
              ["任务未投递超过十分钟", "5", "payments", "", "未投递超过十分钟"],
              ["用户", "25", "users", "", ""],
              ["未删除活动", "25", "activities", "", ""],
            ].map(([label, count, target, status, anomaly]) => (
              <button
                className="activity-panel"
                key={label}
                type="button"
                onClick={() =>
                  update({
                    section: target as Section,
                    status,
                    anomaly,
                    page: 1,
                    detail: "",
                  })
                }
              >
                <span>{label}</span>
                <strong>{count}</strong>
              </button>
            ))}
          </div>
          <section className="activity-panel">
            <h3>运行许可</h3>
            <dl className="prototype-admin-fields">
              <dt>环境</dt>
              <dd>本地</dd>
              <dt>真实付款</dt>
              <dd>不允许 · 本地环境禁用真实付款</dd>
              <dt>限时开奖</dt>
              <dd>允许</dd>
              <dt>真实 / 模拟付款</dt>
              <dd>真实 13 笔；模拟 12 笔</dd>
              <dt>队列实际积压</dt>
              <dd>未接入</dd>
            </dl>
          </section>
          <section className="activity-panel">
            <h3>维护任务最近状态</h3>
            <p>身份同步：暂无运行记录</p>
            <p>活动归档：已完成</p>
            <p>付款补偿：未更新超过十五分钟</p>
            <p>凭证检查：已完成</p>
          </section>
        </>
      ) : section === "settings" ? (
        <SettingsPanel
          draft={draft}
          setDraft={setDraft}
          setMessage={setMessage}
        />
      ) : (
        <>
          {section === "audit" && (
            <p className="text-sm text-subtle">
              仅包含登录方式与参与尝试限流的修改记录。
            </p>
          )}
          <form
            className="prototype-admin-filters"
            onSubmit={(e) => {
              e.preventDefault();
              update({ q: search, page: 1, detail: "" });
            }}
          >
            <label className="field">
              搜索
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button className="button secondary" type="submit">
              搜索
            </button>
            {section !== "activities" && (
              <label className="field">
                类型
                <select
                  value={route.type}
                  onChange={(e) =>
                    update({ type: e.target.value, page: 1, detail: "" })
                  }
                >
                  <option value="">全部</option>
                  {types.map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
            )}
            {section !== "audit" && (
              <label className="field">
                状态
                <select
                  value={route.status}
                  onChange={(e) =>
                    update({ status: e.target.value, page: 1, detail: "" })
                  }
                >
                  <option value="">全部</option>
                  {statuses.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </label>
            )}
            {(section === "activities" || section === "payments") && (
              <label className="field">
                {section === "activities" ? "开奖异常" : "付款异常"}
                <select
                  value={route.anomaly}
                  onChange={(e) =>
                    update({ anomaly: e.target.value, page: 1, detail: "" })
                  }
                >
                  <option value="">全部</option>
                  {anomalies.map((anomaly) => (
                    <option key={anomaly}>{anomaly}</option>
                  ))}
                </select>
              </label>
            )}
            {section === "payments" && (
              <>
                <label className="field">
                  活动标识
                  <input
                    value={route.activity}
                    onChange={(e) =>
                      update({
                        activity: e.target.value,
                        page: 1,
                        detail: "",
                      })
                    }
                  />
                </label>
                <label className="field">
                  商户
                  <select
                    value={route.merchant}
                    onChange={(e) =>
                      update({
                        merchant: e.target.value,
                        page: 1,
                        detail: "",
                      })
                    }
                  >
                    <option value="">全部</option>
                    {merchants.map((merchant) => (
                      <option key={merchant}>{merchant}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  收款人
                  <select
                    value={route.recipient}
                    onChange={(e) =>
                      update({
                        recipient: e.target.value,
                        page: 1,
                        detail: "",
                      })
                    }
                  >
                    <option value="">全部</option>
                    {recipients.map((recipient) => (
                      <option key={recipient}>{recipient}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {section === "audit" && (
              <>
                <label className="field">
                  操作者
                  <input
                    value={route.operator}
                    onChange={(e) =>
                      update({
                        operator: e.target.value,
                        page: 1,
                        detail: "",
                      })
                    }
                  />
                </label>
                <label className="field">
                  开始日期
                  <input
                    type="date"
                    value={route.from}
                    onChange={(e) =>
                      update({ from: e.target.value, page: 1, detail: "" })
                    }
                  />
                </label>
                <label className="field">
                  结束日期
                  <input
                    type="date"
                    value={route.to}
                    onChange={(e) =>
                      update({ to: e.target.value, page: 1, detail: "" })
                    }
                  />
                </label>
              </>
            )}
          </form>
          <div className="prototype-admin-workspace" aria-busy={listRead.busy}>
            <div className="prototype-admin-list">
              <div className="prototype-admin-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{section === "payments" ? "订单" : "名称"}</th>
                      <th>类型</th>
                      <th>{section === "audit" ? "操作者" : "状态"}</th>
                      <th>创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items
                      .slice((route.page - 1) * 20, route.page * 20)
                      .map((row) => (
                        <tr key={row.id}>
                          <td>
                            <button
                              className="prototype-admin-record"
                              type="button"
                              onClick={(e) => {
                                opener.current = e.currentTarget;
                                update({ detail: row.id });
                              }}
                            >
                              {row.name}
                            </button>
                          </td>
                          <td>{row.type}</td>
                          <td>{row.status}</td>
                          <td>{new Date(row.at).toLocaleString("zh-CN")}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!items.length && <p>未匹配到记录。</p>}
              </div>
              <div className="prototype-admin-pagination">
                <button
                  className="button secondary"
                  disabled={route.page <= 1}
                  type="button"
                  onClick={() => update({ page: route.page - 1 })}
                >
                  上一页
                </button>
                <span>
                  第 {route.page} 页 · {items.length} 条
                </span>
                <button
                  className="button secondary"
                  disabled={route.page * 20 >= items.length}
                  type="button"
                  onClick={() => update({ page: route.page + 1 })}
                >
                  下一页
                </button>
              </div>
            </div>
            {route.detail && (
              <PrototypeDetail
                key={`${section}:${route.detail}`}
                row={selected}
                section={section}
                readMode={readMode}
                onClose={() => {
                  update({ detail: "" });
                  requestAnimationFrame(() =>
                    (opener.current?.isConnected
                      ? opener.current
                      : searchRef.current
                    )?.focus({ preventScroll: true }),
                  );
                }}
                onNavigate={(next) => update(next)}
              />
            )}
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function SettingsPanel({
  draft,
  setDraft,
  setMessage,
}: {
  draft: typeof savedSettings;
  setDraft: (value: typeof savedSettings) => void;
  setMessage: (value: string) => void;
}) {
  return (
    <>
      <section className="activity-panel">
        <h3>登录方式</h3>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.lite}
            onChange={(e) => setDraft({ ...draft, lite: e.target.checked })}
          />
          允许 LiteAUTH 登录
        </label>
        <p className="text-sm text-subtle">
          关闭后隐藏青春版登录入口，并阻止新的 LiteAUTH
          登录；已登录用户不受影响。
        </p>
        <button
          className="button"
          type="button"
          disabled={draft.lite === savedSettings.lite}
          onClick={() => {
            savedSettings = {
              ...savedSettings,
              lite: draft.lite,
              updatedAt: Date.now(),
            };
            setDraft({ ...draft, updatedAt: savedSettings.updatedAt });
            setMessage("登录方式已保存。");
          }}
        >
          保存配置
        </button>
      </section>
      <section className="activity-panel">
        <h3>参与尝试限流</h3>
        {[
          ["home", "首页尝试间隔（秒）"],
          ["activity", "活动页尝试间隔（秒）"],
        ].map(([key, label]) => (
          <label className="field" key={key}>
            {label}
            <input
              type="number"
              min={1}
              max={3600}
              value={draft[key as "home" | "activity"]}
              onChange={(e) =>
                setDraft({ ...draft, [key as string]: e.target.value })
              }
            />
          </label>
        ))}
        <button
          className="button"
          type="button"
          disabled={
            draft.home === savedSettings.home &&
            draft.activity === savedSettings.activity
          }
          onClick={() => {
            if (
              ![draft.home, draft.activity].every(
                (value) =>
                  /^\d+$/.test(value) &&
                  Number(value) >= 1 &&
                  Number(value) <= 3600,
              )
            ) {
              setMessage("请填写 1–3600 秒的整数。");
              return;
            }
            savedSettings = {
              ...savedSettings,
              home: draft.home,
              activity: draft.activity,
              updatedAt: Date.now(),
            };
            setDraft({ ...draft, updatedAt: savedSettings.updatedAt });
            setMessage("已保存，将用于下一次获准的尝试。");
          }}
        >
          保存配置
        </button>
      </section>
    </>
  );
}

function PrototypeDetail({
  row,
  section,
  readMode,
  onClose,
  onNavigate,
}: {
  row?: RecordRow;
  section: Section;
  readMode: ReadMode;
  onClose: () => void;
  onNavigate: (next: Partial<Route>) => void;
}) {
  const [detailRead, setDetailRead] = useState(() => readState());
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 700px)").matches,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const readModeRef = useRef(readMode);
  const detailReadRequest = useRef<number | null>(null);
  readModeRef.current = readMode;

  useEffect(
    () => () => {
      if (detailReadRequest.current !== null)
        window.clearTimeout(detailReadRequest.current);
    },
    [],
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    if (!mobile || !dialog.current) return;
    const target = dialog.current;
    target.showModal();
    return () => target.close();
  }, [mobile]);

  const userActions = useMemo(() => {
    if (section !== "users" || !row?.meta?.userId) return null;
    return (
      <div className="prototype-admin-detail-actions">
        <button
          className="button secondary"
          type="button"
          onClick={() =>
            onNavigate({
              section: "activities",
              q: row.meta?.username ?? "",
              page: 1,
              detail: "",
            })
          }
        >
          查看该用户活动
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() =>
            onNavigate({
              section: "payments",
              recipient: row.meta?.recipientId ?? row.meta?.userId ?? "",
              q: "",
              page: 1,
              detail: "",
            })
          }
        >
          查看该用户付款
        </button>
      </div>
    );
  }, [onNavigate, row, section]);

  function refreshDetail() {
    if (detailReadRequest.current !== null) return;
    setDetailRead((old) => ({ ...old, busy: true }));
    detailReadRequest.current = window.setTimeout(() => {
      detailReadRequest.current = null;
      if (readModeRef.current === "error") {
        setDetailRead((old) => ({
          ...old,
          busy: false,
          error: "详情读取失败，请重试。",
        }));
        return;
      }
      setDetailRead(readState());
    }, 180);
  }

  const content = (
    <>
      <header className="prototype-admin-heading">
        <h3>记录详情</h3>
        <div className="prototype-admin-toolbar">
          <CompactIconButton
            aria-label="刷新详情"
            title="刷新详情"
            disabled={detailRead.busy || !row}
            onClick={refreshDetail}
          >
            <RefreshCw
              size={16}
              className={detailRead.busy ? "spin" : undefined}
            />
          </CompactIconButton>
          <CompactIconButton aria-label="关闭详情" onClick={onClose}>
            <X size={16} />
          </CompactIconButton>
        </div>
      </header>
      <p className="text-sm text-subtle">
        详情上次成功读取：{formatReadTime(detailRead.lastSuccessAt)}
      </p>
      {detailRead.error ? (
        <p className="prototype-admin-read-error" role="alert">
          {detailRead.error}上次成功读取：
          {formatReadTime(detailRead.lastSuccessAt)}
        </p>
      ) : null}
      {row ? (
        <>
          <h4>{row.name}</h4>
          <dl className="prototype-admin-fields" aria-busy={detailRead.busy}>
            <dt>ID</dt>
            <dd>{row.id}</dd>
            <dt>类型</dt>
            <dd>{row.type}</dd>
            <dt>状态</dt>
            <dd>{row.status}</dd>
            {row.fields.map(([key, value]) => (
              <div className="prototype-admin-field-row" key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {userActions}
        </>
      ) : (
        <p role="alert">未找到记录。</p>
      )}
    </>
  );
  return mobile ? (
    <dialog
      ref={dialog}
      className="prototype-admin-detail prototype-admin-modal"
      aria-label="记录详情"
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.defaultPrevented) return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter(
          (node) => node.offsetParent !== null && !node.closest("[inert]"),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {content}
    </dialog>
  ) : (
    <aside className="prototype-admin-detail" aria-label="记录详情">
      {content}
    </aside>
  );
}
