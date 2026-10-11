import { describe, expect, it } from "vitest";
import {
  classifyHomeEntry,
  HOME_ENTRY_HELP,
  HOME_ENTRY_LABEL,
} from "../../apps/web/src/lib/home-entry";

const ORIGIN = "https://redeem.example";
const ID = "cecef876-ddbb-4ed5-93ce-9b311e3df3ea";
const CODE = "🚷🎼📯😨😸🎺🐵🦄🪁🚍🤽📄🥘☕";

describe("homepage entry classification", () => {
  it("exports the adopted home entry copy", () => {
    expect(HOME_ENTRY_LABEL).toBe("口令");
    expect(HOME_ENTRY_HELP).toBe(
      "输入口令兑奖，或输入活动标识跳转活动。活动标识支持 14 个 Emoji 表情码、本站活动链接、UUID，以及 https://linux.do/t/topic/… 格式的帖子链接。",
    );
  });

  it.each([
    [ID],
    [ID.toUpperCase()],
    [`  ${ID}  `],
    [CODE],
    [`  ${CODE}  `],
    [`${ORIGIN}/e/${CODE}`],
    [`${ORIGIN}/e/${encodeURIComponent(CODE)}/?source=forum#copied`],
    [`${ORIGIN}/activities/${ID.toUpperCase()}/?source=forum#copied`],
  ])("recognizes activity identifiers and same-origin links: %s", (input) => {
    expect(classifyHomeEntry(input, ORIGIN)).toEqual({
      kind: "activity",
      id: ID,
    });
  });

  it.each([
    "",
    "普通口令123",
    "https://redeem.example/e/not-an-activity-code",
    "🚷🎼📯😨😸🎺🐵🦄🪁🚍🤽📄🥘",
    "🚷🎼📯😨😸🎺🐵🦄🟠🚍🤽📄🥘☕",
    `${ORIGIN}/e/${CODE}/extra`,
    `https://other.example/e/${CODE}`,
  ])("keeps unmatched or incomplete input in password mode: %s", (input) => {
    expect(classifyHomeEntry(input, ORIGIN)).toEqual({ kind: "password" });
  });

  it.each([
    [
      "https://linux.do/t/topic/12345",
      {
        kind: "topic",
        topicId: "12345",
        postNumber: 1,
        topicUrl: "https://linux.do/t/topic/12345/1",
      },
    ],
    [
      "  https://linux.do/t/topic/12345/6?u=someone#last  ",
      {
        kind: "topic",
        topicId: "12345",
        postNumber: 6,
        topicUrl: "https://linux.do/t/topic/12345/6",
      },
    ],
    [
      "https://linux.do/t/topic/000123/",
      {
        kind: "topic",
        topicId: "123",
        postNumber: 1,
        topicUrl: "https://linux.do/t/topic/123/1",
      },
    ],
    [
      "https://linux.do/t/topic/2964597/1216/",
      {
        kind: "topic",
        topicId: "2964597",
        postNumber: 1216,
        topicUrl: "https://linux.do/t/topic/2964597/1216",
      },
    ],
  ])("recognizes strict Linux DO topic links: %s", (input, entry) => {
    expect(classifyHomeEntry(input, ORIGIN)).toEqual(entry);
  });

  it.each([
    "http://linux.do/t/topic/12345",
    "https://LINUX.do/t/topic/12345",
    "https://linux.do:443/t/topic/12345",
    "https://user:pass@linux.do/t/topic/12345",
    "https://linux.do/t/12345",
    "https://linux.do/t/some-title/12345",
    "https://linux.do/t/topic/12345/6/extra",
    "https://linux.do/t/topic/12345/last",
    "https://linux.do/t/topic/0",
    "https://linux.do/t/topic/12345/0",
    "https://linux.do/t/topic/12345/9007199254740992",
    "https://linux.do/t/topic/12345\\6",
    "https://linux.do/t/topic/12345/../6",
    "https://linux.do/t/topic/12345/%2e",
    "https://linux.do/t/topic/12\n345",
    "https://linux.do/t/topic/12345/6more",
  ])("rejects non-homepage topic link shapes: %s", (input) => {
    expect(classifyHomeEntry(input, ORIGIN)).toEqual({ kind: "password" });
  });
});
