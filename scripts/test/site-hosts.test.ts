import { describe, expect, it } from "vitest";
import { movedHosts } from "../../apps/web/src/lib/site-move";
import { pageProblem, readNetwork } from "../../kit/runtime/index.mjs";
import { pageUrlProblem } from "../../packages/contracts/src/page-url";

// A 附带网页, a 判定器's meta.page and its network may not use this site:
// hb.lafi.sh, nor a host it moved from that still reaches the web Worker,
// which sends it on here (sweep 2026-11-21). Each list is written out
// where it runs (the contracts, the kit's sandbox); this holds them to
// site-move.ts, so the next move cannot leave one open.
describe("the site's hosts, the ones it moved from too, stay closed", () => {
  it.each(["hb.lafi.sh", ...Object.keys(movedHosts)])("%s", (host) => {
    for (const name of [host, `staging.${host}`]) {
      expect(pageUrlProblem(`https://${name}/`)).toBe("不能用本站的地址");
      expect(pageProblem(`https://${name}/`)).toBe("不能用本站的地址");
      const read = readNetwork([`https://${name}/api/`]);
      expect("problems" in read ? read.problems : []).toEqual([
        `network 第 1 个（https://${name}/api/）：不能请求 ${host} 和它的子域名`,
      ]);
    }
  });
});
