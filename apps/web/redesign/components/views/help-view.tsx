import { useAtomValue } from "jotai";
import { RED_PACKET } from "../../lib/activity-route";
import { commands, gateFor, isVisible, roleOf } from "../../lib/commands";
import { schemeLabels } from "../../lib/scheme";
import { sessionAtom } from "../../lib/store";
import { GateChip } from "../omnibox/suggestions";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { CommandLink } from "../shell/command-link";
import { useWindowInfo } from "../shell/window-info";
import { Kbd, ShortcutKbd } from "../ui/kbd";
import { radius, Squircle } from "../ui/squircle";

const inputs: { label: string; example: string; note: string }[] = [
  {
    label: schemeLabels.password,
    example: "周末口令2026",
    note: "6–18 个字：汉字、英文字母或数字；查找并领取匹配的红包",
  },
  {
    label: schemeLabels.link,
    example: `/${RED_PACKET}/🔕🐋🌲…☕`,
    note: "红包地址或本站红包链接，直接打开红包",
  },
  {
    label: schemeLabels.emoji,
    example: "🔕🐋🌲…☕",
    note: "14 个表情组成的表情码",
  },
  {
    label: schemeLabels.uuid,
    example: "067e037a-d3f8-…",
    note: "红包的唯一编号",
  },
  {
    label: schemeLabels.topic,
    example: "https://linux.do/t/topic/2964597",
    note: "查看这个帖子里的红包",
  },
  { label: schemeLabels.command, example: "/history", note: "进入站内页面" },
];

/** Short answers to what people ask most, from production's rules. */
const questions: { q: string; a: string }[] = [
  {
    q: "发红包要先做什么？",
    a: "先在“LDC 商户配置”填好你在 LDC 创建的商户应用（Client ID 和密钥）。不用预先付款：每次有人领取，本站从这个商户应用直接付给领取人。",
  },
  {
    q: "我能领自己发的红包吗？",
    a: "不能。打开自己的红包时，印章变淡、不能点，下面有编辑、尝试统计和付款记录的入口。",
  },
  {
    q: "领到的 LDC 什么时候到账？",
    a: "领取后本站马上发起付款，通常几秒内确认。LDC 暂时出问题时会自动核对和重试，不会重复付款；在“红包记录 → 我参与的”能看到每一笔的状态。",
  },
  {
    q: "口令有什么要求？",
    a: "6–18 个字：汉字、英文字母或数字，区分大小写。输入里有全角字母数字或空格时，输入框会提示一键优化。",
  },
  {
    q: "为什么在起始页输入口令找不到红包？",
    a: "开启了“统计口令尝试”的红包，只能在红包页输入口令：请打开发红包的人分享的链接。草稿还没开放，也找不到。",
  },
];

/** /help: what the omnibox understands, every command, and common questions. */
export function HelpView() {
  const role = roleOf(useAtomValue(sessionAtom));
  const visible = commands.filter((command) => isVisible(command, role));
  // A phone has no shortcut keys: the 地址条 is the way in.
  const { compact } = useWindowInfo();
  return (
    <Page>
      <PageHeader
        title="帮助"
        description={
          compact ? (
            "点地址条打开输入框，以 / 开头输入命令。"
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              随时按 <ShortcutKbd /> 打开输入框，按 <Kbd>/</Kbd> 直接输入命令。
            </span>
          )
        }
      />
      <PageSection title="输入框能识别什么">
        <Panel as="ul" className="grid px-4">
          {inputs.map((input) => (
            <li
              key={input.label}
              className="grid gap-x-4 gap-y-0.5 border-line border-b py-3 last:border-b-0 @wide/window:grid-cols-[6rem_1fr]"
            >
              <span className="text-sm font-medium text-ink">
                {input.label}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-sm text-ink-2">
                  {input.example}
                </span>
                <span className="block text-sm text-ink-3">{input.note}</span>
              </span>
            </li>
          ))}
        </Panel>
      </PageSection>
      <PageSection
        title="命令"
        description="也可以用中文、拼音全拼或拼音首字母输入，例如 /历史、/lishi、/ls。"
      >
        <Panel as="ul" className="grid gap-0.5 p-1.5">
          {visible.map((command) => {
            const Icon = command.icon;
            const gate = gateFor(command, role);
            return (
              <li key={command.id}>
                <Squircle radius={radius.row}>
                  <CommandLink
                    command={command}
                    className="flex min-h-12 items-center gap-3 px-3 py-2 transition-colors hover:bg-fill-2"
                  >
                    <Icon className="size-[18px] shrink-0 text-ink-2" />
                    <span className="w-24 shrink-0 font-mono text-sm text-ink">
                      <span className="text-ink-3">/</span>
                      {command.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">
                      {command.title}
                    </span>
                    {gate && <GateChip />}
                  </CommandLink>
                </Squircle>
              </li>
            );
          })}
        </Panel>
      </PageSection>
      <PageSection title="常见问题">
        <Panel as="dl" className="grid px-4">
          {questions.map((item) => (
            <div
              key={item.q}
              className="grid gap-1 border-line border-b py-3.5 last:border-b-0"
            >
              <dt className="text-base font-medium text-ink">{item.q}</dt>
              <dd className="text-sm text-ink-2">{item.a}</dd>
            </div>
          ))}
        </Panel>
      </PageSection>
    </Page>
  );
}
