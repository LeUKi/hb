import { useRouter } from "@tanstack/react-router";
import {
  Braces,
  ChevronRight,
  Coffee,
  Fish,
  Gift,
  type LucideIcon,
  Plus,
} from "lucide-react";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { useWindowInfo } from "../shell/window-info";
import { IconTile } from "../ui/icon-tile";
import { Kbd, ShortcutKbd } from "../ui/kbd";
import { PointsMark } from "../ui/points-mark";
import { radius, Squircle } from "../ui/squircle";

// 帮助中心's front page (docs/help-center-design.md §2.1): what you came to
// do, then what people ask most, each a link to its answer.

type Role = {
  to: string;
  icon: LucideIcon | ComponentType<{ className?: string }>;
  title: string;
  note: string;
};

const useRoles: Role[] = [
  {
    to: "/help/claim",
    icon: Gift,
    title: "领红包",
    note: "口令、领不到、什么时候到账",
  },
  {
    to: "/help/send",
    icon: Plus,
    title: "发红包",
    note: "商户、玩法、设置、发放暂停",
  },
  {
    to: "/help/tips",
    icon: Coffee,
    title: "收打赏",
    note: "打赏卡、嵌进帖子、到账",
  },
  {
    to: "/help/fish",
    icon: Fish,
    title: "🐟额和 PLUS",
    note: "转出、受邀开通",
  },
];

const makeRoles: Role[] = [
  {
    to: "/help/start",
    icon: Braces,
    title: "做玩法",
    note: "判定器、附带网页、自己的服务",
  },
  {
    to: "/help/points",
    icon: PointsMark,
    title: "发行三方积分",
    note: "让你网站的积分能发红包",
  },
];

const asked: { q: string; to: string }[] = [
  { q: "口令没错，为什么匹配不到红包？", to: "/help/claim#q-no-match" },
  { q: "为什么说我不在领取范围里？", to: "/help/claim#q-not-in-scope" },
  { q: "领到的什么时候到账？", to: "/help/claim#q-when-paid" },
  { q: "提示没有 Credit 账户怎么办？", to: "/help/claim#q-no-credit" },
  { q: "发红包要先做什么？", to: "/help/send#q-before-send" },
  { q: "发放暂停、余额不足是怎么回事？", to: "/help/send#q-funds-paused" },
  { q: "怎么开通🐟额 PLUS？", to: "/help/fish#q-plus-join" },
  { q: "怎么做一个小游戏红包？", to: "/help/start#q-first-game" },
];

/** A real link the router follows; a modified click opens a new tab. */
function Go({
  to,
  className,
  children,
  ...rest
}: {
  to: string;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<"a">, "href">) {
  const router = useRouter();
  return (
    <a
      {...rest}
      href={to}
      className={className}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        router.history.push(to);
      }}
    >
      {children}
    </a>
  );
}

function RoleCards({ roles }: { roles: Role[] }) {
  return (
    <div className="grid gap-2 @wide/window:grid-cols-2">
      {roles.map(({ to, icon: Icon, title, note }) => (
        <Squircle key={to} radius={radius.choice}>
          <Go
            to={to}
            className="choice flex min-w-0 items-center gap-3 px-3.5 py-3"
          >
            <IconTile icon={Icon} large />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="truncate text-base font-medium text-ink">
                {title}
              </span>
              <span className="truncate text-sm text-ink-3">{note}</span>
            </span>
            <ChevronRight
              className="size-4 shrink-0 text-ink-3"
              aria-hidden="true"
            />
          </Go>
        </Squircle>
      ))}
    </div>
  );
}

/** /help: pick what you came to do, or go straight to a common question. */
export function HelpView() {
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
      <PageSection title="你要做什么">
        <RoleCards roles={useRoles} />
      </PageSection>
      <PageSection title="开发和接入">
        <RoleCards roles={makeRoles} />
      </PageSection>
      <PageSection title="大家常问">
        <Panel as="ul" className="grid gap-0.5 p-1.5">
          {asked.map((item) => (
            <li key={item.to}>
              <Squircle radius={radius.row}>
                <Go
                  to={item.to}
                  className="flex min-h-12 items-center gap-3 px-3 py-2 transition-colors hover:bg-fill-2"
                >
                  <span className="min-w-0 flex-1 text-ink">{item.q}</span>
                  <ChevronRight
                    className="size-4 shrink-0 text-ink-3"
                    aria-hidden="true"
                  />
                </Go>
              </Squircle>
            </li>
          ))}
        </Panel>
      </PageSection>
    </Page>
  );
}
