import { Link } from "@tanstack/react-router";
import { KIT_AGENTS_PAGE_URL, KIT_AGENTS_URL, KIT_URL } from "../../lib/judge";
import { approaches, approachLines, keyPoints } from "../../lib/kit-guide";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { Block } from "./help-api-view";

// /help/start: 做一个玩法 (docs/kit-guide-design.md §8), where someone making
// a game starts, whichever parts it needs. The table is the kit's 选做法;
// /help/code and /help/page stay the references it leads to.

const linkClass = "text-accent-ink hover:underline";

/** The way here from the two reference pages. */
export function StartLink() {
  return (
    <Link to="/help/start" className={`text-sm ${linkClass}`}>
      不知道用哪种做法？先看“做一个玩法”
    </Link>
  );
}

/** A table cell: its `marks` are code. */
function Marked({ text }: { text: string }) {
  return text
    .split(/`([^`]+)`/)
    .map((piece, index) =>
      index % 2 === 1 ? <Code key={piece}>{piece}</Code> : piece,
    );
}

/** GitHub's anchor for a heading of AGENTS.md. */
const sectionHref = (name: string) =>
  `${KIT_AGENTS_PAGE_URL}#${name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-")}`;

/**
 * 接着读: “节名” is a section of AGENTS.md, [字](地址) a page of this site
 * (the table has the production address, for those who read it in the kit).
 */
function Reading({ text }: { text: string }) {
  const pieces = [...text.matchAll(/“([^”]+)”|\[([^\]]+)\]\(([^)]+)\)/g)];
  return pieces.map((piece, index) => {
    const [whole, section, label, address] = piece;
    return (
      <span key={whole}>
        {index > 0 && "、"}
        {section ? (
          <a
            href={sectionHref(section)}
            target="_blank"
            rel="noreferrer"
            className={linkClass}
          >
            {section} ↗
          </a>
        ) : (
          <Link
            to={new URL(address ?? "/").pathname as "/help/page"}
            className={linkClass}
          >
            {label}
          </Link>
        )}
      </span>
    );
  });
}

/**
 * For an AI, whichever way it goes: the key points and 选做法, and where to
 * read the rest. /help/code and /help/page keep theirs for a chat AI that
 * reads no address and has one part to write.
 */
const aiPrompt = (
  origin: string,
) => `你要帮我做一个“lafish的红包站”的红包玩法。先读完下面的要点和选做法，按我的需求选一种做法，跟我确认以后再动手。

资料：
- 本地开发包：${KIT_URL} ，用 npx degit LeUKi/hb/kit 我的红包 取到本地，里面有能跑通的模板、网页模板和模拟器。
- 完整说明 AGENTS.md（纯文本，能直接读）：${KIT_AGENTS_URL} 。选定做法以后，读里面用得到的几节。
- 如果你读不了网址，告诉我，我把 ${origin}/help/code 或 ${origin}/help/page 里的“给 AI 的说明”贴给你。

要点（先读）：
${keyPoints}

选做法（能简单就简单：越往下，要部署、要维护、会出错的东西越多）：
${approachLines}

我的玩法是：（在这里写清楚：玩什么、怎么算输赢、奖池多大、谁能玩、要不要网页、一个人多久操作一次）`;

const parts = [
  [
    "判定器",
    "决定给谁多少钱，钱只经过它。代码在红包站的沙箱里跑，红包开放时就定在当时那一版。",
  ],
  [
    "附带网页",
    "给人看、给人点。显示在红包页旁边，手机上在底部抽屉里；普通红包也能带。",
  ],
  [
    "你的服务",
    "需要时才有：存档、调 AI、跑整个游戏。它算出的结果要经判定器核对，才会发钱。",
  ],
] as const;

const docs = [
  {
    to: "/help/code",
    label: "代码判定红包 · 开发文档",
    note: "判定器的代码协议、能用的模块、测试的写法",
  },
  {
    to: "/help/page",
    label: "附带网页 · 接入说明",
    note: "把自己的网站嵌进红包页、沿用网站的登录、接上 SDK",
  },
] as const;

const kitDocs = [
  {
    href: KIT_AGENTS_PAGE_URL,
    label: "开发包的完整说明 AGENTS.md ↗",
    note: "每种做法的写法，也是给 AI 读的",
  },
  { href: KIT_URL, label: "本地开发包 ↗", note: "模板、测试命令和模拟器" },
] as const;

const docRow =
  "grid gap-0.5 border-line border-b py-2.5 text-sm last:border-b-0";

export function HelpStartView() {
  return (
    <Page>
      <PageHeader
        back={{ label: "帮助", href: "/help" }}
        title="做一个玩法"
        description="红包的玩法可以写成判定器，可以配一个网页，也可以接自己的服务。先按需求选一种做法，再看对应的说明。"
      />
      <PageSection
        title="选一种做法"
        description={
          <>
            能简单就简单：越往下，要部署、要维护、会出错的东西越多。不想写代码的话，去
            <Link to="/judges" className={linkClass}>
              判定器广场
            </Link>
            选一个现成的，填好参数就能发红包。
          </>
        }
      >
        <Panel as="ul" className="grid px-4">
          {approaches.map((row) => (
            <li
              key={row.name}
              className="grid gap-1 border-line border-b py-3 text-sm last:border-b-0"
            >
              <span className="font-medium text-ink">{row.name}</span>
              <span className="text-ink-2">
                <Marked text={row.need} />
              </span>
              <span className="text-ink-3">
                要写的：
                <Marked text={row.write} />
              </span>
              <span className="text-ink-3">费用：{row.cost}</span>
              <span className="text-ink-3">
                接着读：
                <Reading text={row.read} />
              </span>
            </li>
          ))}
        </Panel>
      </PageSection>
      <PageSection
        id="ai"
        title="给 AI 的说明"
        description="整段复制给 AI，把最后一行换成你的玩法。它会先选做法，再按做法写。"
      >
        <Block label="提示词" code={aiPrompt(window.location.origin)} wrap />
      </PageSection>
      <PageSection title="三样东西各做什么">
        <Panel as="dl" className="grid px-4">
          {parts.map(([name, note]) => (
            <div key={name} className={docRow}>
              <dt className="font-medium text-ink">{name}</dt>
              <dd className="text-ink-2">{note}</dd>
            </div>
          ))}
        </Panel>
      </PageSection>
      <PageSection title="详细文档">
        <Panel as="ul" className="grid px-4">
          {docs.map((doc) => (
            <li key={doc.to} className={docRow}>
              <Link to={doc.to} className={linkClass}>
                {doc.label}
              </Link>
              <span className="text-ink-2">{doc.note}</span>
            </li>
          ))}
          {kitDocs.map((doc) => (
            <li key={doc.href} className={docRow}>
              <a
                href={doc.href}
                target="_blank"
                rel="noreferrer"
                className={linkClass}
              >
                {doc.label}
              </a>
              <span className="text-ink-2">{doc.note}</span>
            </li>
          ))}
        </Panel>
      </PageSection>
    </Page>
  );
}
