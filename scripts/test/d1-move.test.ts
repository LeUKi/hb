import { describe, expect, it } from "vitest";
import { checkTarget, compareSnapshots, countQuery } from "../d1-move";

describe("d1-move", () => {
  it("only moves into a new database of the same environment", () => {
    expect(checkTarget("staging", "hb-staging", "hb-staging-apac")).toBe(
      "hb-staging-apac",
    );
    expect(() => checkTarget("staging", "hb-staging", "hb-staging")).toThrow(
      "TARGET_IS_SOURCE",
    );
    expect(() =>
      checkTarget("staging", "hb-staging", "hb-production-apac"),
    ).toThrow("TARGET_NOT_IN_ENVIRONMENT");
    expect(() => checkTarget("production", "hb-production", "hb-prod")).toThrow(
      "TARGET_NOT_IN_ENVIRONMENT",
    );
    expect(() => checkTarget("staging", "hb-staging", "")).toThrow(
      "TARGET_NAME_INVALID",
    );
    expect(() =>
      checkTarget("staging", "hb-staging", "hb-staging-apac; DROP"),
    ).toThrow("TARGET_NAME_INVALID");
  });

  it("counts every table in one query, refusing names it cannot quote", () => {
    expect(countQuery(["users", "d1_migrations"])).toBe(
      `SELECT 'users' AS name, COUNT(*) AS count FROM "users" UNION ALL SELECT 'd1_migrations' AS name, COUNT(*) AS count FROM "d1_migrations"`,
    );
    expect(() => countQuery([])).toThrow("NO_TABLES");
    expect(() => countQuery(['users"; --'])).toThrow("TABLE_NAME_UNSUPPORTED");
  });

  it("lists every table and schema object type that differs", () => {
    const source = {
      tables: { users: 423, claims: 561, d1_migrations: 28 },
      objects: { table: 3, index: 40, trigger: 74 },
    };
    expect(compareSnapshots(source, structuredClone(source))).toEqual([]);
    expect(
      compareSnapshots(source, {
        tables: { users: 423, claims: 560 },
        objects: { table: 2, index: 40, trigger: 73, view: 1 },
      }),
    ).toEqual([
      "table claims: 561 → 560",
      "table d1_migrations: 28 → missing",
      "tables: 3 → 2",
      "triggers: 74 → 73",
      "views: 0 → 1",
    ]);
  });
});
