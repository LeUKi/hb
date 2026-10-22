/** A stand-in drand quicknet round: its randomness is its signature's SHA-256. */
export function fakeDrandRound(round: number): {
  round: number;
  randomness: string;
  signature: string;
};
