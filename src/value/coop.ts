/**
 * Co-op value-routing — turn verified contribution weights into a fair payout
 * split via the Shapley value. This is the layer that sits ON TOP of trust:
 * Meridian says whose contribution is real (signed); this says what it is worth
 * on a shared payout.
 *
 * The VALUE FUNCTION is the open design choice (RHIZOME-WIRING.md decision #3),
 * so it is pluggable. Two reference functions ship:
 *   - `additiveValue`      — value = total weight present. Shapley reduces to each
 *                            member's own weight (the proportional baseline).
 *   - `quorumGatedValue(q)`— the co-op produces nothing until `q` members are
 *                            present; Shapley then rewards the members who carry
 *                            the coalition to critical mass, not just raw output.
 *
 * Weights are intended to come from VERIFIED contribution receipts (Meridian),
 * never self-report — value routing over unverified membership is just a nicer
 * way to get gamed.
 */
import { shapleyValues } from "./shapley.ts";

export type Contributor = { memberId: string; weight: number };

/** value(coalition) given a lookup of each member's weight. v([]) must be 0. */
export type CoopValueFn = (weightOf: (memberId: string) => number, coalition: string[]) => number;

export const additiveValue: CoopValueFn = (weightOf, coalition) =>
  coalition.reduce((sum, m) => sum + weightOf(m), 0);

export function quorumGatedValue(quorum: number): CoopValueFn {
  return (weightOf, coalition) =>
    coalition.length >= quorum ? coalition.reduce((sum, m) => sum + weightOf(m), 0) : 0;
}

export interface PayoutShare {
  memberId: string;
  weight: number;
  /** Raw Shapley value under the chosen value function. */
  shapley: number;
  /** Shapley value normalized to the payout — what the member is owed. */
  share: number;
}

/**
 * Split `payout` across contributors by Shapley value under `valueFn`.
 * Efficiency guarantee: Σ share === payout (up to float rounding), because the
 * Shapley values are normalized by their own total before scaling to the payout.
 */
export function distributePayout(
  payout: number,
  contributors: Contributor[],
  valueFn: CoopValueFn = additiveValue,
): PayoutShare[] {
  const weightMap = new Map(contributors.map((c) => [c.memberId, c.weight]));
  const weightOf = (m: string): number => weightMap.get(m) ?? 0;
  const players = contributors.map((c) => c.memberId);

  const phi = shapleyValues(players, (coalition) => valueFn(weightOf, coalition));
  const total = players.reduce((sum, m) => sum + (phi[m] ?? 0), 0);

  return contributors.map((c) => {
    const shapley = phi[c.memberId] ?? 0;
    const share = total > 0 ? (shapley / total) * payout : 0;
    return { memberId: c.memberId, weight: c.weight, shapley, share };
  });
}
