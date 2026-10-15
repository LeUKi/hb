// 口令尝试统计 (📊) for the demo account's 红包 that have it on. Production
// keeps every submission on the 红包 page that reaches validation (claims,
// sign-ups, 验证其他口令), encrypted, and shows only these aggregates —
// never who submitted what. Made-up numbers.

export type AttemptRow = {
  /** What was submitted, as typed. */
  text: string;
  count: number;
  people: number;
  hits: number;
  misses: number;
  /** Successful claims (or sign-ups) made with it. */
  claims: number;
};

export type AttemptStats = {
  total: number;
  people: number;
  claims: number;
  rows: AttemptRow[];
};

const stats: Record<string, AttemptStats> = {
  // 读书会 · 十月书单
  "c2b7f1a4-5d3e-4f6a-9b8c-1d2e3f4a5b6c": {
    total: 26,
    people: 12,
    claims: 3,
    rows: [
      { text: "十月书单", count: 7, people: 5, hits: 0, misses: 7, claims: 0 },
      {
        text: "十月书单2026",
        count: 5,
        people: 4,
        hits: 5,
        misses: 0,
        claims: 3,
      },
      { text: "三体", count: 4, people: 3, hits: 0, misses: 4, claims: 0 },
      {
        text: "十月书单2025",
        count: 3,
        people: 3,
        hits: 0,
        misses: 3,
        claims: 0,
      },
      { text: "百年孤独", count: 2, people: 2, hits: 0, misses: 2, claims: 0 },
      {
        text: "shiyueshudan2026",
        count: 2,
        people: 1,
        hits: 0,
        misses: 2,
        claims: 0,
      },
      { text: "活着", count: 1, people: 1, hits: 0, misses: 1, claims: 0 },
      {
        text: "十月书单 2026",
        count: 1,
        people: 1,
        hits: 0,
        misses: 1,
        claims: 0,
      },
      {
        text: "读书会2026",
        count: 1,
        people: 1,
        hits: 0,
        misses: 1,
        claims: 0,
      },
    ],
  },
};

export function attemptStatsOf(activityId: string): AttemptStats {
  return stats[activityId] ?? { total: 0, people: 0, claims: 0, rows: [] };
}
