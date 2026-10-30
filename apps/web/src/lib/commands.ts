import type { LucideIcon } from "lucide-react";
import {
  CircleHelp,
  Fish,
  FolderCode,
  History,
  LayoutGrid,
  LogIn,
  Plus,
  ReceiptText,
  Settings2,
  Store,
  Trophy,
  UserRound,
} from "lucide-react";
import type { SessionUser } from "./session";

// "/" commands: the way into every non-activity page. Canonical names are
// short English words (they are also the URL paths); Chinese names, full
// pinyin and pinyin initials all match.

export type Role = "guest" | "standard" | "admin";

export function roleOf(user: SessionUser | null): Role {
  if (!user) return "guest";
  return user.isAdmin ? "admin" : "standard";
}

/** What an account has been let into beyond its role (🐟额's allowlist). */
export type CommandFeatures = { balance?: boolean };

export function featuresOf(user: SessionUser | null): CommandFeatures {
  return { balance: user?.balance === true };
}

export type CommandPath =
  | "/new"
  | "/history"
  | "/balance"
  | "/square"
  | "/rank"
  | "/me"
  | "/merchant"
  | "/payments"
  | "/admin"
  | "/judges"
  | "/help";

export type CommandId =
  | "new"
  | "history"
  | "balance"
  | "square"
  | "rank"
  | "me"
  | "merchant"
  | "payments"
  | "admin"
  | "judges"
  | "help"
  | "login";

export type Command = {
  id: CommandId;
  /** Null for commands that act in place (login opens the account card). */
  path: CommandPath | null;
  /** Canonical name typed after "/". */
  name: string;
  title: string;
  icon: LucideIcon;
  /** Minimum role that can use it; lower roles see it with a gate badge. */
  requires: Role;
  /** Hidden entirely for roles that should not even see it. */
  visibleTo?: (role: Role) => boolean;
  /** Shown only to accounts let into it (CommandFeatures). */
  feature?: keyof CommandFeatures;
  /** Offered as a chip on the start page. */
  quick?: boolean;
  keys: string[];
};

export const commands: Command[] = [
  {
    id: "new",
    path: "/new",
    name: "new",
    title: "发红包",
    icon: Plus,
    requires: "standard",
    keys: [
      "new",
      "create",
      "add",
      "发红包",
      "发起",
      "新建",
      "创建",
      "fahongbao",
      "fhb",
      "faqi",
      "fq",
      "xinjian",
      "xj",
      "chuangjian",
      "cj",
    ],
  },
  {
    id: "history",
    path: "/history",
    name: "history",
    title: "红包记录",
    icon: History,
    requires: "standard",
    quick: true,
    keys: [
      "history",
      "his",
      "红包记录",
      "记录",
      "历史",
      "参与",
      "hongbaojilu",
      "hbjl",
      "jilu",
      "jl",
      "lishi",
      "ls",
      "canyu",
      "cy",
    ],
  },
  {
    id: "balance",
    path: "/balance",
    name: "balance",
    title: "🐟额",
    icon: Fish,
    requires: "standard",
    visibleTo: (role) => role !== "guest",
    feature: "balance",
    keys: [
      "balance",
      "fish",
      "站内🐟额",
      "🐟额",
      "鱼额",
      "余额",
      "转入",
      "转出",
      "yue",
      "ye",
      "zhuanru",
      "zr",
      "zhuanchu",
      "zc",
    ],
  },
  {
    id: "square",
    path: "/square",
    name: "square",
    title: "红包广场",
    icon: LayoutGrid,
    requires: "guest",
    quick: true,
    keys: [
      "square",
      "public",
      "explore",
      "红包广场",
      "广场",
      "公开红包",
      "公开",
      "hongbaoguangchang",
      "hbgc",
      "guangchang",
      "gc",
      "gongkaihongbao",
      "gkhb",
      "gongkai",
      "gk",
    ],
  },
  {
    id: "rank",
    path: "/rank",
    name: "rank",
    title: "排行榜",
    icon: Trophy,
    requires: "guest",
    quick: true,
    keys: [
      "rank",
      "leaderboard",
      "top",
      "排行榜",
      "排行",
      "排名",
      "榜单",
      "paihangbang",
      "phb",
      "paihang",
      "paiming",
      "pm",
      "bangdan",
    ],
  },
  {
    id: "me",
    path: "/me",
    name: "me",
    title: "账号资料",
    icon: UserRound,
    requires: "standard",
    visibleTo: (role) => role !== "guest",
    keys: [
      "me",
      "account",
      "profile",
      "我的",
      "账号",
      "资料",
      "账号资料",
      "wode",
      "wd",
      "zhanghao",
      "zh",
      "ziliao",
      "zl",
    ],
  },
  {
    id: "merchant",
    path: "/merchant",
    name: "merchant",
    title: "LDC 商户配置",
    icon: Store,
    requires: "standard",
    visibleTo: (role) => role !== "guest",
    keys: [
      "merchant",
      "shop",
      "ldc",
      "ldc商户",
      "ldc商户配置",
      "商户",
      "商户配置",
      "ldcshanghu",
      "shanghu",
      "sh",
      "peizhi",
      "pz",
    ],
  },
  {
    id: "payments",
    path: "/payments",
    name: "payments",
    title: "付款记录",
    icon: ReceiptText,
    requires: "standard",
    visibleTo: (role) => role !== "guest",
    keys: [
      "payments",
      "payment",
      "pay",
      "付款",
      "付款记录",
      "发放",
      "fukuan",
      "fk",
      "fafang",
      "ff",
    ],
  },
  {
    id: "admin",
    path: "/admin",
    name: "admin",
    title: "网站管理",
    icon: Settings2,
    requires: "admin",
    visibleTo: (role) => role === "admin",
    keys: ["admin", "管理", "网站管理", "后台", "guanli", "gl", "houtai", "ht"],
  },
  {
    id: "help",
    path: "/help",
    name: "help",
    title: "帮助",
    icon: CircleHelp,
    requires: "guest",
    keys: ["help", "帮助", "说明", "bangzhu", "bz", "shuoming", "sm"],
  },
  {
    // 判定器广场 (docs/judge-square-design.md §8, §15.4): anyone may look.
    id: "judges",
    path: "/judges",
    name: "judges",
    title: "判定器广场",
    icon: FolderCode,
    requires: "guest",
    // On the start page too (2026-10-30, the user).
    quick: true,
    keys: [
      "judges",
      "judge",
      "判定器",
      "判定器广场",
      "我的判定器",
      "代码判定",
      "pandingqi",
      "pdq",
      "pandingqiguangchang",
      "pdqgc",
      "wodepandingqi",
      "wdpdq",
    ],
  },
  {
    id: "login",
    path: null,
    name: "login",
    title: "登录",
    icon: LogIn,
    requires: "guest",
    visibleTo: (role) => role === "guest",
    keys: ["login", "signin", "登录", "denglu", "dl"],
  },
];

const byId = new Map(commands.map((command) => [command.id, command]));

export function commandById(id: CommandId) {
  const command = byId.get(id);
  if (!command) throw new Error(`Unknown command ${id}`);
  return command;
}

export function isVisible(
  command: Command,
  role: Role,
  features: CommandFeatures = {},
) {
  if (command.feature && !features[command.feature]) return false;
  return command.visibleTo?.(role) ?? true;
}

/** Guests see "需登录" on commands for signed-in users; admin is a page check. */
export function gateFor(command: Command, role: Role): null | "login" {
  return role === "guest" && command.requires !== "guest" ? "login" : null;
}

/** NFKC folds full-width letters; IME separators and spaces are dropped. */
export function normalizeQuery(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s'’·]/gu, "");
}

/** "/", full-width "／" and the Pinyin-IME "、" all start a command. */
const prefix = /^\s*[/／、]+/u;

export function commandQuery(raw: string): string | null {
  const match = prefix.exec(raw);
  return match ? normalizeQuery(raw.slice(match[0].length)) : null;
}

function isSubsequence(needle: string, haystack: string) {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

const keyCache = new Map<CommandId, string[]>();
function keysOf(command: Command) {
  let keys = keyCache.get(command.id);
  if (!keys) {
    keys = command.keys.map(normalizeQuery);
    keyCache.set(command.id, keys);
  }
  return keys;
}

function score(command: Command, query: string) {
  const keys = keysOf(command);
  const title = normalizeQuery(command.title);
  if (command.name === query || keys.includes(query)) return 100;
  if (command.name.startsWith(query)) return 90;
  if (keys.some((key) => key.startsWith(query))) return 80;
  if (title.startsWith(query)) return 75;
  if (title.includes(query)) return 70;
  if (query.length >= 2 && keys.some((key) => key.includes(query))) return 60;
  // Loose typing ("hsty") only against the canonical English name; pinyin keys
  // are long enough that subsequences would match almost anything.
  if (
    query.length >= 2 &&
    /^[a-z]+$/u.test(query) &&
    isSubsequence(query, command.name)
  )
    return 30;
  return 0;
}

/** Visible commands ranked for a query (empty query: registry order). */
export function matchCommands(
  query: string,
  role: Role,
  features: CommandFeatures = {},
  limit = 8,
) {
  const visible = commands.filter((command) =>
    isVisible(command, role, features),
  );
  if (!query) return visible.slice(0, limit);
  return visible
    .map((command, index) => ({ command, index, score: score(command, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.command);
}
