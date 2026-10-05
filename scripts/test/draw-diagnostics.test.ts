import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { diagnosticQueries, diagnosticWarnings } from "../payment-diagnostics";

describe("draw operation diagnostics", () => {
  it("reports overdue closure and saved unpublished plans without reading private payloads", () => {
    const query = diagnosticQueries(2_000_000).find(
      (item) => item.name === "draws",
    );
    expect(query).toBeDefined();
    const rows = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          `
import json,sqlite3,sys
c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.executescript('''
CREATE TABLE activities(id,payment_mode,draw_state,registered_count,deadline,draw_closed_at,deleted_at);
CREATE TABLE activity_draw_plans(activity_id,payload);
INSERT INTO activities VALUES ('due','real','waiting',7,1000000,NULL,NULL);
INSERT INTO activities VALUES ('planned','real','settling',3,1000000,1100000,NULL);
INSERT INTO activities VALUES ('future','simulation','waiting',1,3000000,NULL,NULL);
INSERT INTO activities VALUES ('done','real','completed',4,500000,500000,NULL);
INSERT INTO activities VALUES ('deleted','real','waiting',8,1,NULL,1);
INSERT INTO activity_draw_plans VALUES ('planned','private plan must not appear');
''')
print(json.dumps([dict(r) for r in c.execute(sys.argv[1])]))
`,
          query?.sql ?? "",
        ],
        { encoding: "utf8" },
      ),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payment_mode: "real",
          draw_state: "waiting",
          activities: 1,
          registrations: 7,
          overdue: 1,
          oldest_wait_seconds: 1000,
        }),
        expect.objectContaining({
          payment_mode: "real",
          draw_state: "settling",
          unpublished_plans: 1,
          oldest_wait_seconds: 900,
        }),
        expect.objectContaining({
          payment_mode: "simulation",
          draw_state: "waiting",
          overdue: 0,
          oldest_wait_seconds: 0,
        }),
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain("private plan");
    expect(diagnosticWarnings({ draws: rows })).toContain(
      "DRAW_SETTLEMENT_WAIT_OVER_TEN_MINUTES",
    );
    expect(
      diagnosticWarnings({
        draws: [{ draw_state: "completed", oldest_wait_seconds: 1000 }],
      }),
    ).not.toContain("DRAW_SETTLEMENT_WAIT_OVER_TEN_MINUTES");
  });
});
