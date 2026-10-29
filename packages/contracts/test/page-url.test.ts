import { describe, expect, it } from "vitest";
import { pageProblem, readMeta } from "../../../kit/runtime/params.mjs";
import {
  activityInputSchema,
  attachedPageOf,
  emptyActivityInput,
  normalizePageUrl,
  pageUrlProblem,
} from "../src";

// 附带网页's address (docs/attached-page-design.md §1).

describe("附带网页: the address", () => {
  it("takes an https page with a path, ? and #, as the URL standard writes it", () => {
    expect(pageUrlProblem("")).toBeNull();
    expect(pageUrlProblem("  ")).toBeNull();
    expect(pageUrlProblem("https://example.com")).toBeNull();
    expect(
      normalizePageUrl(" https://Puzzle.Example.com/题目?day=3#top "),
    ).toBe("https://puzzle.example.com/%E9%A2%98%E7%9B%AE?day=3#top");
    expect(normalizePageUrl("")).toBeNull();
    expect(attachedPageOf("https://puzzle.example.com/a")).toEqual({
      url: "https://puzzle.example.com/a",
      host: "puzzle.example.com",
    });
  });

  it("says what is wrong, one rule at a time", () => {
    expect(pageUrlProblem("example.com")).toBe("不是有效的地址");
    expect(pageUrlProblem("http://example.com")).toBe(
      "只能用 https:// 开头的地址",
    );
    expect(pageUrlProblem("https://me:pw@example.com")).toBe(
      "不能带用户名和密码",
    );
    expect(pageUrlProblem("https://example.com:8443/")).toBe("不能带端口");
    expect(pageUrlProblem("https://1.2.3.4/")).toBe("不能写 IP 地址");
    expect(pageUrlProblem("https://[::1]/")).toBe("不能写 IP 地址");
    expect(pageUrlProblem("https://localhost/")).toBe("不能写 localhost");
    expect(pageUrlProblem("https://intranet/")).toBe(
      "要写完整的域名（比如 example.com）",
    );
    expect(pageUrlProblem("https://linux.do/t/1")).toBe(
      "不能用 linux.do 和它的子域名",
    );
    expect(pageUrlProblem("https://connect.linux.do/")).toBe(
      "不能用 linux.do 和它的子域名",
    );
    expect(pageUrlProblem("https://hb.lafi.sh/🧧/x")).toBe("不能用本站的地址");
    expect(pageUrlProblem(`https://example.com/${"a".repeat(500)}`)).toBe(
      "最多 500 个字",
    );
    // Only those exact sites: a name that merely ends the same way is fine.
    expect(pageUrlProblem("https://notlinux.do/")).toBeNull();
  });

  it("is checked by the activity schema, absent or empty meaning none", () => {
    const base = { ...emptyActivityInput(), title: "附带网页" };
    const pageIssues = (pageUrl?: string) =>
      (
        activityInputSchema.safeParse(
          pageUrl === undefined ? base : { ...base, pageUrl },
        ).error?.issues ?? []
      )
        .filter((issue) => issue.path[0] === "pageUrl")
        .map((issue) => issue.message);
    expect(pageIssues()).toEqual([]);
    expect(pageIssues("")).toEqual([]);
    expect(pageIssues("https://example.com/a")).toEqual([]);
    expect(pageIssues("http://example.com")).toEqual([
      "只能用 https:// 开头的地址",
    ]);
  });
});

// 判定器带的附带网页 (docs/judge-page-design.md §4, §11.9): judge.js's
// meta.page, read by the kit and the site's deploy, under the same rules.
describe("附带网页: a 判定器's meta.page", () => {
  const addresses = [
    "https://example.com",
    " https://Game.Example.com/玩?x=1#a ",
    "example.com",
    "http://example.com",
    "https://user:pw@example.com",
    "https://example.com:8443",
    "https://127.0.0.1",
    "https://[::1]",
    "https://localhost",
    "https://a.localhost",
    "https://intranet",
    "https://example.com.",
    "https://linux.do/t/1",
    "https://connect.linux.do",
    "https://hb.lafi.sh/help",
    "https://x.hb.lafi.sh",
    `https://example.com/${"a".repeat(500)}`,
  ];

  it("holds the kit to the form's and the API's rules", () => {
    for (const address of addresses)
      expect(pageProblem(address), address).toBe(pageUrlProblem(address));
    expect(pageProblem("")).toBe("要是不空的字符串");
    expect(pageProblem(42)).toBe("要是不空的字符串");
  });

  it("keeps it as the URL standard writes it, and says what is wrong", () => {
    expect(
      readMeta({ name: "猜数字", page: " https://Game.Example.com/玩 " }),
    ).toEqual({
      meta: { name: "猜数字", page: "https://game.example.com/%E7%8E%A9" },
    });
    expect(normalizePageUrl("https://Game.Example.com/玩")).toBe(
      "https://game.example.com/%E7%8E%A9",
    );
    expect(readMeta({ name: "猜数字", page: "http://example.com" })).toEqual({
      problems: ["meta.page：只能用 https:// 开头的地址"],
    });
    expect(readMeta({ name: "猜数字", url: "https://example.com" })).toEqual({
      problems: ["meta 里不认识 url：只能写 name、description 和 page"],
    });
    expect(readMeta("猜数字")).toEqual({
      problems: ["meta 要是 { name, description, page }"],
    });
  });
});
