import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LIMITS,
  activityInputSchema,
  adminActivitiesQuerySchema,
  adminAuditQuerySchema,
  adminCursorSchema,
  adminPaymentsQuerySchema,
  claimActivitySchema,
  claimSpeedTitle,
  createActivitySchema,
  decodeActivityEmoji,
  emptyActivityInput,
  encodeActivityEmoji,
  historicalActivityInputSchema,
  newActivityInputSchema,
  normalizeTopicLink,
  passwordSchema,
  passwordSolveSchema,
  updateActivitySchema,
} from "../src/index";

const itemId = "760a1a6f-1aa5-4a4a-a3ba-58f6e4c59aaf";
const otherId = "3423508c-4d81-44c5-86c2-0fba29ab868c";
function validActivity() {
  return {
    ...emptyActivityInput(),
    title: "LDC 活动",
    passwords: ["ABC123"],
    merchantId: otherId,
  };
}

describe("shared activity contracts", () => {
  it("names the speed title by the time since opening", () => {
    expect(claimSpeedTitle(9_999)).toBe("flash");
    expect(claimSpeedTitle(10_000)).toBe("flash");
    expect(claimSpeedTitle(10_001)).toBe("fastest");
  });

  it("keeps legacy password requests unchanged and accepts explicit direct participation only", () => {
    const legacy = { submissionId: itemId, password: "ABC123" };
    expect(JSON.stringify(claimActivitySchema.parse(legacy))).toBe(
      JSON.stringify(legacy),
    );
    const direct = { submissionId: itemId, participationMode: "direct" };
    expect(claimActivitySchema.parse(direct)).toEqual(direct);
    expect(passwordSolveSchema.safeParse(direct).success).toBe(false);
    for (const value of [
      { ...direct, password: "ABC123" },
      { ...direct, discoveryId: otherId },
      { submissionId: itemId },
      { submissionId: itemId, participationMode: "password" },
    ])
      expect(claimActivitySchema.safeParse(value).success).toBe(false);
    expect(
      passwordSolveSchema.parse({ ...legacy, participationMode: "password" }),
    ).toEqual({ ...legacy, participationMode: "password" });
  });

  it("requires genuine passwords only in password mode and excludes hidden direct configuration", () => {
    const legacy = activityInputSchema.parse(validActivity());
    expect(Object.hasOwn(legacy, "participationMode")).toBe(false);
    const direct = {
      ...validActivity(),
      participationMode: "direct",
      passwords: [],
      forceDedicated: false,
    };
    expect(newActivityInputSchema.parse(direct)).toMatchObject(direct);
    for (const invalid of [
      { ...direct, passwords: ["ABC123"] },
      { ...direct, forceDedicated: true },
      { ...direct, participationMode: "password" },
      { ...direct, participationMode: undefined },
    ])
      expect(newActivityInputSchema.safeParse(invalid).success).toBe(false);
    for (const money of [
      { mode: "fixed", totalAmount: "2.00", count: 2 },
      {
        mode: "random",
        totalAmount: "2.00",
        count: 2,
        algorithm: "double_mean_v1",
      },
      { mode: "custom", amounts: ["1.00", "2.00"] },
      {
        mode: "timed_draw",
        totalAmount: "2.00",
        count: 2,
        algorithm: "double_mean_v1",
        countdownSeconds: 600,
        participantLimit: null,
        distributeFullPool: true,
      },
    ])
      expect(
        newActivityInputSchema.safeParse({
          ...direct,
          rewardType: "ldc",
          merchantId: otherId,
          money,
          allocation:
            money.mode === "random" || money.mode === "timed_draw"
              ? "random"
              : "sequential",
        }).success,
      ).toBe(true);
  });

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
    expect(passwordSchema.parse(`${"诗".repeat(28)}2026`)).toHaveLength(32);
    expect(passwordSchema.safeParse("a".repeat(33)).success).toBe(false);
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

  it("rejects retired text reward requests and missing reward type", () => {
    const retired = {
      ...validActivity(),
      rewardType: "text",
      rewards: [{ id: itemId, text: "PRIVATE-TEXT" }],
    };
    const missing = { ...validActivity() };
    delete (missing as Partial<typeof missing>).rewardType;
    for (const schema of [
      activityInputSchema,
      historicalActivityInputSchema,
      newActivityInputSchema,
    ]) {
      expect(schema.safeParse(retired).success).toBe(false);
      expect(schema.safeParse(missing).success).toBe(false);
    }
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
    for (const deadline of [
      { mode: "duration", value: 0, unit: "hours" },
      { mode: "duration", value: 1.5, unit: "hours" },
      { mode: "duration", value: 1, unit: "weeks" },
      { mode: "duration", value: 1 },
      { mode: "duration", unit: "hours" },
    ]) {
      expect(
        activityInputSchema.safeParse({ ...validActivity(), deadline }).success,
      ).toBe(false);
    }
  });

  it("accepts legacy and explicit duration units", () => {
    for (const deadline of [
      { mode: "duration" },
      { mode: "duration", value: 30, unit: "minutes" },
      { mode: "duration", value: 12, unit: "hours" },
      { mode: "duration", value: 7, unit: "days" },
    ]) {
      expect(
        activityInputSchema.safeParse({ ...validActivity(), deadline }).success,
      ).toBe(true);
    }
  });

  it("limits new passwords and quantity choices without invalidating historical input", () => {
    const input = validActivity();
    // 32 口令 since 2026-10-25 (5 before).
    expect(ACTIVITY_LIMITS.passwords).toBe(32);
    input.passwords = Array.from({ length: 33 }, (_, i) => `Secret${i}`);
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
    });
    // The roster is always public: new input carries no roster switches.
    expect(emptyActivityInput()).not.toHaveProperty("showRecipientList");
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
        title: " LDC 活动 ",
        topicUrl: ` ${topicUrl} `,
        passwords: [" ABC123 "],
        // Sent before the roster became public; still parsed in place, so a
        // retried request keeps its digest.
        showRecipientList: true,
        showRecipientUsername: true,
        showRecipientTime: true,
        showRecipientAmount: true,
      };
      const parsed = historicalActivityInputSchema.parse(input);
      const historicalValue = {
        title: "LDC 活动",
        topicUrl,
        forceDedicated: false,
        joinSquare: false,
        deadline: { mode: "duration" },
        allocation: "sequential",
        passwords: ["ABC123"],
        quantityVisibility: "exact",
        showRecipientList: true,
        showRecipientUsername: true,
        showRecipientTime: true,
        showRecipientAmount: true,
        beforeInfo: "",
        afterClaimInfo: "",
        afterEndInfo: "",
        rewardType: "ldc",
        merchantId: otherId,
        money: { mode: "fixed", totalAmount: "1.00", count: 1 },
      };
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(historicalValue));
      expect(
        createActivitySchema.parse({ requestId: itemId, activity: input })
          .activity,
      ).toEqual(parsed);
      expect(newActivityInputSchema.safeParse(input).success).toBe(false);
      expect(activityInputSchema.safeParse(input).success).toBe(false);
      expect(
        updateActivitySchema.safeParse({ version: 1, activity: input }).success,
      ).toBe(false);
      expect(Object.keys(parsed)).toEqual([
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

describe("admin read-only contracts", () => {
  const cursor = `1700000000000:${itemId}`;
  const auditCursor = `1700000000000:attempt_rate_limits:${itemId}`;

  it("validates admin cursor formats used by list and audit endpoints", () => {
    expect(adminCursorSchema.parse(cursor)).toBe(cursor);
    expect(adminAuditQuerySchema.parse({ cursor: auditCursor }).cursor).toBe(
      auditCursor,
    );
    for (const invalid of [
      "",
      "abc:id",
      "1700000000000",
      "1700000000000:",
      "9007199254740992:item",
      "1700000000000:bad/type:id",
      `1700000000000:unknown:${itemId}`,
      `1700000000000:ATTEMPT_RATE_LIMITS:${itemId}`,
      `1700000000000:login_settings:${itemId}`,
    ]) {
      expect(adminCursorSchema.safeParse(invalid).success).toBe(false);
      expect(adminAuditQuerySchema.safeParse({ cursor: invalid }).success).toBe(
        false,
      );
    }
  });

  it("accepts and rejects admin search filters at the shared contract boundary", () => {
    const longEmojiLink = `https://redemption.example.test/e/${encodeURIComponent(encodeActivityEmoji(itemId))}?utm_source=admin-history`;
    expect(longEmojiLink.length).toBeGreaterThan(200);
    expect(adminActivitiesQuerySchema.parse({ q: longEmojiLink }).q).toBe(
      longEmojiLink,
    );
    expect(adminPaymentsQuerySchema.parse({ q: longEmojiLink }).q).toBe(
      longEmojiLink,
    );
    expect(
      adminActivitiesQuerySchema.parse({
        q: "  活动名  ",
        rewardType: "ldc",
        status: "active",
        drawException: "1",
        cursor,
      }),
    ).toMatchObject({ q: "活动名", rewardType: "ldc", status: "active" });
    expect(
      adminPaymentsQuerySchema.parse({
        q: "business-1",
        activityId: itemId,
        merchantId: otherId,
        mode: "real",
        status: "attention",
        anomaly: "undelivered",
        exception: "0",
        cursor,
      }),
    ).toMatchObject({ activityId: itemId, merchantId: otherId });
    // 未发出: a 🐟额 转出 Credit refused for good.
    expect(adminPaymentsQuerySchema.parse({ status: "failed" }).status).toBe(
      "failed",
    );
    for (const invalid of [
      { rewardType: "money" },
      { status: "running" },
      { drawException: "true" },
      { unexpected: "value" },
    ])
      expect(adminActivitiesQuerySchema.safeParse(invalid).success).toBe(false);
    for (const invalid of [
      { activityId: "not-uuid" },
      { mode: "live" },
      { status: "lost" },
      { anomaly: "stuck" },
      { exception: "true" },
    ])
      expect(adminPaymentsQuerySchema.safeParse(invalid).success).toBe(false);
  });

  it("uses the shared canonical Ecoji activity code decoder", () => {
    const code = encodeActivityEmoji(itemId);
    expect(Array.from(code)).toHaveLength(14);
    expect(decodeActivityEmoji(code)).toBe(itemId);
    expect(decodeActivityEmoji(code.slice(0, -1))).toBeNull();
    expect(decodeActivityEmoji(`${code.slice(0, -1)}😀`)).toBeNull();
  });
});
