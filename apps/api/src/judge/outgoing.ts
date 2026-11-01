// What the gateway adds to a 联网 judgment's request besides its own
// headers (gateway.ts), read anew for each: the 密钥 whose address it is
// (docs/judge-key-design.md §1; a 密钥 changed applies from the next
// request), and, to an address its sender filled in or one that asks for
// it, the site's token, X-Hb-Token (docs/judge-address-design.md §12): who
// sent the 红包 and which one, signed with the keys a page's server checks
// hb.identity() with, under an issuer of its own.
import type { JudgeDeclarations, JudgeNetworkEntry } from "@hb/contracts";
import {
  allowedBy,
  keyHeaders,
  keyParams,
  tokenAddresses,
} from "../../../../kit/runtime/index.mjs";
import { signClaims } from "../activities/page-identity";
import type { ApiBindings } from "../env";
import { storedKeys } from "./keys";

/** How long the token lasts: one request. */
const TOKEN_SECONDS = 60;

export async function outgoingHeaders(
  env: ApiBindings,
  activityId: string,
  address: string,
): Promise<[string, string][]> {
  const row = await env.DB.prepare(
    `SELECT v.declarations, v.network, c.params_public AS shown, u.external_id AS sender,
        EXISTS(SELECT 1 FROM activity_keys k WHERE k.activity_id = c.activity_id) AS keyed
      FROM activity_code c JOIN activities a ON a.id = c.activity_id JOIN users u ON u.id = a.author_id
        JOIN judge_versions v ON v.judge_id = c.judge_id AND v.n = c.judge_version
      WHERE c.activity_id = ?`,
  )
    .bind(activityId)
    .first<{
      declarations: string | null;
      network: string | null;
      shown: string | null;
      sender: string;
      keyed: number;
    }>();
  if (!row) return [];
  const params = row.declarations
    ? (JSON.parse(row.declarations) as JudgeDeclarations).params
    : [];
  const shown = row.shown
    ? (JSON.parse(row.shown) as Record<string, unknown>)
    : {};
  const headers =
    row.keyed === 1 && keyParams(params).length > 0
      ? keyHeaders(params, await storedKeys(env, activityId), address, shown)
      : [];
  const network = row.network
    ? (JSON.parse(row.network) as JudgeNetworkEntry[])
    : [];
  if (allowedBy(tokenAddresses(network, shown), address)) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signClaims(env, {
      iss: `${env.APP_ORIGIN || "https://hb.lafi.sh"}/judge`,
      aud: new URL(address).origin,
      hongbao: activityId,
      sender: String(row.sender),
      iat: issuedAt,
      exp: issuedAt + TOKEN_SECONDS,
      jti: crypto.randomUUID(),
    });
    if (token) headers.push(["x-hb-token", token]);
  }
  return headers;
}
