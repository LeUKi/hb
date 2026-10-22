import {
  type ActivityProofData,
  DRAND_QUICKNET,
  drandRoundMatches,
  drawPlanV2,
  drawSeed,
  queueAmountsV2,
  queueCommitment,
  queueSeed,
  rosterHash,
} from "@hb/contracts";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { readResponse } from "./activities";

// 开奖证明 (docs/draw-proof-design.md): the browser redoes a v2 红包's random
// parts with the same code the server ran, from the data anyone can read,
// and the round from two drand nodes (their answers must agree).

export type DrawData = Extract<ActivityProofData, { kind: "draw" }>;
export type QueueData = Extract<ActivityProofData, { kind: "queue" }>;

/** Cloudflare's drand node, and drand's own. */
export const DRAND_NODES = [
  "https://drand.cloudflare.com",
  "https://api.drand.sh",
] as const;

export const drandRoundUrl = (round: number, node: string = DRAND_NODES[0]) =>
  `${node}/${DRAND_QUICKNET.chainHash}/public/${round}`;

export const proofKey = (id: string) => ["activity-proof", id] as const;

/** 🎲's own name: a 限时开奖's 开奖数据, a queue's 发放数据. */
export function useDrawDataName(id: string | null) {
  const { data } = useQuery({
    queryKey: proofKey(id ?? ""),
    queryFn: () => readProofData(id ?? ""),
    enabled: false,
  });
  return data?.kind === "queue" ? "发放数据" : "开奖数据";
}

export async function readProofData(id: string, signal?: AbortSignal) {
  return readResponse<ActivityProofData>(
    await api.api.activities[":id"].proof.$get(
      { param: { id } },
      { init: { signal, cache: "no-store" } },
    ),
  );
}

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Both nodes give this round exactly as it was used. */
export async function nodesAgree(data: DrawData) {
  const { round, randomness, signature } = data.drand;
  const answers = await Promise.all(
    DRAND_NODES.map(async (node) => {
      const response = await fetch(drandRoundUrl(round, node), {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("drand round unavailable");
      return (await response.json()) as {
        round: number;
        randomness: string;
        signature: string;
      };
    }),
  );
  return answers.every(
    (answer) =>
      answer.round === round &&
      answer.randomness === randomness &&
      answer.signature === signature &&
      drandRoundMatches(answer),
  );
}

export function rosterMatches(data: DrawData) {
  return (
    rosterHash(
      data.roster.entries.map((entry) => ({
        ordinal: entry.ordinal,
        registrationId: entry.registrationId,
      })),
    ) === data.roster.hash
  );
}

function recomputedSeed(data: DrawData) {
  const { randomness, round } = data.drand;
  return randomness === null
    ? null
    : drawSeed({
        activityId: data.activity.id,
        rosterHash: data.roster.hash,
        round,
        randomness,
      });
}

export function seedMatches(data: DrawData) {
  return data.seed !== null && recomputedSeed(data) === data.seed;
}

/** The ordinals as drawn, the prize pool and each winner's prize. */
export function resultMatches(data: DrawData) {
  const seed = recomputedSeed(data);
  if (!seed || !data.result) return false;
  const plan = drawPlanV2({
    seed,
    registered: data.roster.entries.length,
    money: data.activity.money,
  });
  return (
    same(plan.picked, data.result.picked) &&
    same(plan.amounts, data.result.amounts) &&
    same(plan.winners, data.result.winners)
  );
}

export function commitmentMatches(data: QueueData) {
  return (
    data.secret !== null &&
    queueCommitment(data.activity.id, data.secret) === data.commitment
  );
}

export function queueMatches(data: QueueData) {
  if (!data.secret || !data.queue) return false;
  return same(
    queueAmountsV2({
      seed: queueSeed(data.activity.id, data.secret),
      money: data.activity.money,
    }),
    data.queue.map((item) => item.amountMinor),
  );
}

export const claimedCount = (data: QueueData) =>
  data.queue?.filter((item) => item.claim).length ?? 0;

/** Handed out in order: the first k shares went to the k who claimed. */
export function claimedInOrder(data: QueueData) {
  const taken = claimedCount(data);
  return (
    data.queue?.every(
      (item, index) => (item.claim !== null) === index < taken,
    ) ?? false
  );
}
