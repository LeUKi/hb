import { describe, expect, it } from "vitest";
import {
  activityPath,
  createActivityImageEmbed,
  encodeActivityEmoji,
  FORUM_EMOJI,
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

const nameOf = new Map([...FORUM_EMOJI].map(([name, emoji]) => [emoji, name]));
/** As the forum hands copied text back: its emoji as :name:. */
const asCopiedFromForum = (text: string) =>
  text.replace(/🧧\/[^\s]+/gu, (path) =>
    [...path].map((c) => (nameOf.has(c) ? `:${nameOf.get(c)}:` : c)).join(""),
  );

describe("share text (05 §5), written", () => {
  it("puts the 社区专用链接 in a code block, the site's post behind 红包站", () => {
    expect(forumShareLink(id)).toBe(
      [
        "```",
        `/🧧/${code}`,
        "```",
        "复制上面这段，粘贴到[红包站](https://linux.do/t/3033290)的输入框就能打开红包。",
      ].join("\n"),
    );
  });

  it("puts the path and its 口令 in one code block under the title", () => {
    expect(forumShareWithPassword(activity, password)).toBe(
      [
        "【周末红包】",
        "```",
        `/🧧/${code}`,
        "口令：周末口令2026",
        "```",
        "复制上面这段，粘贴到[红包站](https://linux.do/t/3033290)的输入框就能领。",
      ].join("\n"),
    );
    expect(
      forumShareWithPassword(
        { ...activity, draw: true, pageOnly: true },
        password,
      )
        .split("\n")
        .at(-1),
    ).toBe(
      "这个红包关闭了首页领取：复制上面整段，粘贴到[红包站](https://linux.do/t/3033290)的输入框就能报名。",
    );
  });

  it("keeps the plain one plain, saying so when 首页领取 is off", () => {
    expect(plainShareWithPassword(activity, url, password)).toBe(
      `【周末红包】\n${url}\n口令：周末口令2026`,
    );
    expect(
      plainShareWithPassword({ ...activity, pageOnly: true }, url, password),
    ).toBe(
      `【周末红包】\n${url}\n口令：周末口令2026\n这个红包关闭了首页领取，请打开上面的链接再输入口令。`,
    );
  });
});

describe("share text, read back from a paste (02 §6)", () => {
  // Every form the menu gives out: what it names comes back.
  const forms: [string, string, string | null][] = [
    ["社区专用链接", forumShareLink(id), null],
    ["专用链接与口令", forumShareWithPassword(activity, password), password],
    [
      "专用链接与口令（关闭首页领取、报名）",
      forumShareWithPassword(
        { ...activity, draw: true, pageOnly: true },
        password,
      ),
      password,
    ],
    [
      "社区内嵌代码",
      createActivityImageEmbed({ activityId: id, origin, sender: "小满" }),
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
