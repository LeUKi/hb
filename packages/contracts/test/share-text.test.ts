import { describe, expect, it } from "vitest";
import {
  activityPath,
  createActivityImageEmbed,
  encodeActivityEmoji,
  FORUM_EMOJI,
  FORUM_POST_URL,
  forumShareLink,
  forumShareWithPassword,
  plainShareWithPassword,
  readShareText,
  type ShareActivity,
} from "../src";

const id = "550e8400-e29b-41d4-a716-446655440000";
const code = encodeActivityEmoji(id);
const origin = "https://hb.example.com";
const url = `${origin}/🧧/${code}`;
const activity: ShareActivity = {
  id,
  title: "周末红包",
  draw: false,
  pageOnly: false,
};
const password = "周末口令2026";
/** 红包站 links to the site by default, or to its post (05 §5). */
const site = origin;

const nameOf = new Map([...FORUM_EMOJI].map(([name, emoji]) => [emoji, name]));
/** As the forum hands copied text back: its emoji as :name:. */
const asCopiedFromForum = (text: string) =>
  text.replace(/🧧\/[^\s]+/gu, (path) =>
    [...path].map((c) => (nameOf.has(c) ? `:${nameOf.get(c)}:` : c)).join(""),
  );

describe("share text (05 §5), written to one rule", () => {
  const how = (result: string) =>
    `复制上面这段，粘贴到[红包站](${site})的输入框即可${result}。`;

  it("puts the link in a code block under the title, 红包站 linking to the site or its post", () => {
    expect(forumShareLink(activity, site)).toBe(
      ["【周末红包】", "```", `/🧧/${code}`, "```", how("打开红包")].join("\n"),
    );
    expect(forumShareLink(activity, FORUM_POST_URL).split("\n").at(-1)).toBe(
      "复制上面这段，粘贴到[红包站](https://linux.do/t/3033290)的输入框即可打开红包。",
    );
  });

  it("puts the path and its 口令 in one code block under the title", () => {
    expect(forumShareWithPassword(activity, password, site)).toBe(
      [
        "【周末红包】",
        "```",
        `/🧧/${code}`,
        "口令：周末口令2026",
        "```",
        how("领取"),
      ].join("\n"),
    );
  });

  it("adds one line of its own when 首页领取 is off, the rest as it is", () => {
    expect(
      forumShareWithPassword({ ...activity, pageOnly: true }, password, site),
    ).toBe(
      `${forumShareWithPassword(activity, password, site)}\n本红包已关闭首页领取，只输入口令无法领取。`,
    );
    // A 限时开奖 signs up.
    expect(
      forumShareWithPassword(
        { ...activity, draw: true, pageOnly: true },
        password,
        site,
      )
        .split("\n")
        .slice(-2),
    ).toEqual([how("报名"), "本红包已关闭首页领取，只输入口令无法报名。"]);
  });

  it("keeps the plain one plain, with the same extra line when 首页领取 is off", () => {
    expect(plainShareWithPassword(activity, url, password)).toBe(
      `【周末红包】\n${url}\n口令：周末口令2026`,
    );
    expect(
      plainShareWithPassword({ ...activity, pageOnly: true }, url, password),
    ).toBe(
      `【周末红包】\n${url}\n口令：周末口令2026\n本红包已关闭首页领取，请先打开上面的链接再输入口令。`,
    );
  });
});

describe("share text, read back from a paste (02 §6)", () => {
  // Every form the menu gives out: what it names comes back.
  const forms: [string, string, string | null][] = [
    ["发到社区 · 链接", forumShareLink(activity, site), null],
    ["发到社区 · 链接（主贴）", forumShareLink(activity, FORUM_POST_URL), null],
    [
      "专用链接与口令",
      forumShareWithPassword(activity, password, site),
      password,
    ],
    [
      "专用链接与口令（关闭首页领取、报名）",
      forumShareWithPassword(
        { ...activity, draw: true, pageOnly: true },
        password,
        FORUM_POST_URL,
      ),
      password,
    ],
    [
      "社区内嵌代码",
      createActivityImageEmbed({
        activityId: id,
        origin,
        sender: "小满",
        link: url,
      }),
      null,
    ],
    ["原始链接", url, null],
    [
      "原始链接与口令",
      plainShareWithPassword(activity, url, password),
      password,
    ],
    [
      "原始链接与口令（关闭首页领取）",
      plainShareWithPassword({ ...activity, pageOnly: true }, url, password),
      password,
    ],
  ];

  for (const [name, text, expected] of forms)
    it(`reads ${name} back`, () => {
      expect(readShareText(text)).toEqual({
        activityId: id,
        password: expected,
      });
      // Copied out of the forum, its emoji come as :name:.
      expect(readShareText(asCopiedFromForum(text))).toEqual({
        activityId: id,
        password: expected,
      });
    });

  it("reads the code block's inside alone, and older copy", () => {
    expect(readShareText(`${activityPath(id)}\n口令：${password}`)).toEqual({
      activityId: id,
      password,
    });
    expect(
      readShareText(
        `【周末红包】\n[\`/🧧/${code}\`](https://linux.do/t/3033290)\n口令：\`${password}\``,
      ),
    ).toEqual({ activityId: id, password });
  });

  it("reads a 口令 line alone, and a link percent-encoded", () => {
    expect(readShareText("口令：`周末口令2026`")).toEqual({
      activityId: null,
      password,
    });
    expect(readShareText(encodeURI(url))).toEqual({
      activityId: id,
      password: null,
    });
  });

  it("leaves ordinary input alone, and a title that says 口令", () => {
    for (const text of ["周末口令2026", "/history", "口令：太短", "🧧"])
      expect(readShareText(text)).toBeNull();
    expect(readShareText(`【口令：猜猜看】\n/🧧/${code}`)).toEqual({
      activityId: id,
      password: null,
    });
  });
});
