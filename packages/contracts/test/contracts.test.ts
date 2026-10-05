import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LIMITS,
  activityInputSchema,
  claimActivitySchema,
  createActivitySchema,
  emptyActivityInput,
  historicalActivityInputSchema,
  newActivityInputSchema,
  normalizeTopicLink,
  passwordSchema,
  updateActivitySchema,
} from "../src/index";

const itemId = "760a1a6f-1aa5-4a4a-a3ba-58f6e4c59aaf";
const otherId = "3423508c-4d81-44c5-86c2-0fba29ab868c";
function validActivity() {
  return {
    ...emptyActivityInput(),
    title: "文本活动",
    passwords: ["ABC123"],
    rewards: [{ id: itemId, text: "  CODE\n第二行  " }],
  };
}

describe("shared activity contracts", () => {
  it("binds claims to an explicit UUID and the same normalized password rules", () => {
    expect(
      claimActivitySchema.parse({ submissionId: itemId, password: " ABC123 " }),
    ).toEqual({ submissionId: itemId, password: "ABC123" });
    for (const value of [
      { submissionId: "not-an-id", password: "ABC123" },
      { submissionId: itemId, password: "短" },
      { submissionId: itemId, password: "ABC123", userId: "another-user" },
    ]) {
      expect(claimActivitySchema.safeParse(value).success).toBe(false);
    }
  });
  it("trims passwords, counts Unicode characters and keeps case significant", () => {
    expect(passwordSchema.parse("  ABC123  ")).toBe("ABC123");
    expect(passwordSchema.parse("𠀀𠀀𠀀𠀀𠀀𠀀")).toBe("𠀀𠀀𠀀𠀀𠀀𠀀");
    expect(passwordSchema.safeParse("𠀀𠀀𠀀𠀀𠀀").success).toBe(false);
    expect(passwordSchema.safeParse("ＡＢＣ１２３").success).toBe(false);
    expect(passwordSchema.safeParse("ABC 123").success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(19)).success).toBe(false);
    expect(
      activityInputSchema.parse({
        ...validActivity(),
        passwords: ["ABC123", "abc123"],
      }).passwords,
    ).toHaveLength(2);
    expect(
      activityInputSchema.safeParse({
        ...validActivity(),
        passwords: ["ABC123", " ABC123 "],
      }).success,
    ).toBe(false);
  });

  it("preserves reward whitespace, multiline content and duplicate text as separate items", () => {
    const input = validActivity();
    input.rewards.push({ id: otherId, text: input.rewards[0]?.text ?? "" });
    expect(activityInputSchema.parse(input).rewards).toEqual(input.rewards);
    input.rewards[1] = { id: itemId, text: "different" };
    expect(activityInputSchema.safeParse(input).success).toBe(false);
  });

  it("measures reward limits in UTF-8 bytes without silently truncating", () => {
    const input = validActivity();
    input.rewards = [
      { id: itemId, text: "a".repeat(ACTIVITY_LIMITS.rewardBytes) },
    ];
    expect(activityInputSchema.safeParse(input).success).toBe(true);
    input.rewards[0] = { id: itemId, text: "汉".repeat(5462) };
    expect(activityInputSchema.safeParse(input).success).toBe(false);
    input.rewards[0] = { id: itemId, text: "\n \t" };
    expect(activityInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects incomplete configurations, overlong descriptions and unknown input keys", () => {
    expect(activityInputSchema.safeParse(emptyActivityInput()).success).toBe(
      false,
    );
    expect(
      activityInputSchema.safeParse({
        ...validActivity(),
        title: "a".repeat(101),
      }).success,
    ).toBe(false);
    expect(
      activityInputSchema.safeParse({
        ...validActivity(),
        afterEndInfo: "a".repeat(10001),
      }).success,
    ).toBe(false);
    expect(
      activityInputSchema.safeParse({
        ...validActivity(),
        ownerId: "someone-else",
      }).success,
    ).toBe(false);
    expect(
      activityInputSchema.safeParse({
        ...validActivity(),
        deadline: { mode: "at", at: "2026-10-03T20:00" },
      }).success,
    ).toBe(false);
  });

  it("limits new passwords and quantity choices without invalidating historical input", () => {
    const input = validActivity();
    input.passwords = Array.from({ length: 6 }, (_, i) => `Secret${i}`);
    expect(activityInputSchema.safeParse(input).success).toBe(true);
    expect(newActivityInputSchema.safeParse(input).success).toBe(false);
    input.passwords.pop();
    expect(newActivityInputSchema.safeParse(input).success).toBe(true);
    for (const quantityVisibility of ["hidden", "availability"]) {
      expect(
        activityInputSchema.safeParse({ ...input, quantityVisibility }).success,
      ).toBe(true);
      expect(
        newActivityInputSchema.safeParse({ ...input, quantityVisibility })
          .success,
      ).toBe(false);
    }
    expect(emptyActivityInput()).toMatchObject({
      quantityVisibility: "exact",
      showRecipientList: true,
    });
  });

  it("canonicalizes shared topic links without fetching their content", () => {
    for (const [link, postNumber] of [
      ["https://linux.do/t/topic/12345/6?u=someone#last", 6],
      ["https://linux.do/t/12345/6", 6],
      ["http://linux.do/t/another-slug/12345", 1],
      ["https://linux.do/t/topic/2964597/1216", 1216],
    ] as const) {
      expect(normalizeTopicLink(link)).toEqual({
        topicId: link.includes("2964597") ? "2964597" : "12345",
        postNumber,
        topicUrl: `https://linux.do/t/${link.includes("2964597") ? "2964597" : "12345"}/${postNumber}`,
      });
    }
    expect(normalizeTopicLink(" ")).toBeNull();
    for (const link of [
      "https://linux.do.evil.test/t/123",
      "https://evil.test/t/123",
      "https://linux.do@evil.test/t/123",
      "https://user:pass@linux.do/t/123",
      "https://linux.do:8080/t/123",
      "javascript:alert(1)",
      "https://linux.do/u/user",
      "https://linux.do/t/0",
      "https://linux.do/t/123/0",
      "https://linux.do/t/topic/123/-1",
      "https://linux.do/t/123/4/extra",
      "https://linux.do/t/topic/123/4/extra",
      "https://linux.do/t//123",
      "https://linux.do/t/123/1.5",
      "https://linux.do/t/123/9007199254740992",
    ]) {
      expect(normalizeTopicLink(link)).toBeNull();
      expect(
        activityInputSchema.safeParse({ ...validActivity(), topicUrl: link })
          .success,
      ).toBe(false);
    }
  });

  it.each([
    "https://linux.do/t/topic/12345/last",
    "https://linux.do/t/12345/4/extra",
  ])(
    "retains historical create-envelope links and digest field order: %s",
    (topicUrl) => {
      const input = {
        ...validActivity(),
        title: " 文本活动 ",
        topicUrl: ` ${topicUrl} `,
        passwords: [" ABC123 "],
      };
      const parsed = historicalActivityInputSchema.parse(input);
      const legacyValue = {
        title: "文本活动",
        topicUrl,
        forceDedicated: false,
        rewardType: "text",
        joinSquare: false,
        deadline: { mode: "duration" },
        allocation: "sequential",
        passwords: ["ABC123"],
        rewards: input.rewards,
        quantityVisibility: "exact",
        showRecipientList: true,
        showRecipientUsername: true,
        showRecipientTime: true,
        showRecipientAmount: true,
        beforeInfo: "",
        afterClaimInfo: "",
        afterEndInfo: "",
      };
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacyValue));
      expect(
        createActivitySchema.parse({ requestId: itemId, activity: input })
          .activity,
      ).toEqual(parsed);
      expect(newActivityInputSchema.safeParse(input).success).toBe(false);
      expect(activityInputSchema.safeParse(input).success).toBe(false);
      expect(
        updateActivitySchema.safeParse({ version: 1, activity: input }).success,
      ).toBe(false);
      const { rewards: _rewards, ...withoutRewards } = input;
      const ldcInput = {
        ...withoutRewards,
        rewardType: "ldc",
        merchantId: otherId,
        money: { mode: "fixed", totalAmount: "1.00", count: 1 },
      };
      const parsedLdc = historicalActivityInputSchema.parse(ldcInput);
      expect(parsedLdc.topicUrl).toBe(topicUrl);
      expect(Object.keys(parsedLdc)).toEqual([
        "title",
        "topicUrl",
        "forceDedicated",
        "joinSquare",
        "deadline",
        "allocation",
        "passwords",
        "quantityVisibility",
        "showRecipientList",
        "showRecipientUsername",
        "showRecipientTime",
        "showRecipientAmount",
        "beforeInfo",
        "afterClaimInfo",
        "afterEndInfo",
        "rewardType",
        "merchantId",
        "money",
      ]);
      expect(newActivityInputSchema.safeParse(ldcInput).success).toBe(false);
    },
  );

  it("keeps historical create envelopes bound to the original trusted host", () => {
    for (const topicUrl of [
      "https://evil.example/t/topic/12345/last",
      "https://linux.do.evil.example/t/12345/last",
      "https://user:secret@linux.do/t/12345/last",
      "https://linux.do:8080/t/12345/last",
      "https://linux.do/t/0/last",
    ])
      expect(
        createActivitySchema.safeParse({
          requestId: itemId,
          activity: { ...validActivity(), topicUrl },
        }).success,
      ).toBe(false);
  });
});
