/**
 * Exact Shapley value (Lloyd Shapley, 1953) — the provably-unique fair division
 * of a coalition's worth. For each player i over player set N:
 *
 *   φ_i = Σ_{S ⊆ N\{i}}  [ |S|! · (n−|S|−1)! / n! ] · ( v(S ∪ {i}) − v(S) )
 *
 * It is pinned down by four axioms (efficiency, symmetry, null-player,
 * additivity), so "here is what you are objectively owed" is a theorem, not the
 * co-op's opinion. Exact computation is O(2^n · n); a co-op payout round is
 * small, so we compute it exactly and cap n for safety.
 */

export const MAX_EXACT_PLAYERS = 18;

function popcount(x: number): number {
  let c = 0;
  while (x !== 0) {
    x &= x - 1;
    c++;
  }
  return c;
}

/**
 * Shapley value of every player under coalition value function `v`.
 * `v([])` should be 0 (the empty coalition produces nothing).
 */
export function shapleyValues(
  players: string[],
  v: (coalition: string[]) => number,
): Record<string, number> {
  const n = players.length;
  if (n === 0) return {};
  if (n > MAX_EXACT_PLAYERS) {
    throw new Error(`exact Shapley is limited to ${MAX_EXACT_PLAYERS} players, got ${n}`);
  }

  const fact: number[] = [1];
  for (let k = 1; k <= n; k++) fact[k] = fact[k - 1]! * k;

  const phi: Record<string, number> = {};
  for (const p of players) phi[p] = 0;

  // Cache v over subsets keyed by bitmask so each coalition is evaluated once.
  const vCache = new Map<number, number>();
  const vOf = (mask: number): number => {
    const hit = vCache.get(mask);
    if (hit !== undefined) return hit;
    const coalition: string[] = [];
    for (let i = 0; i < n; i++) if ((mask & (1 << i)) !== 0) coalition.push(players[i]!);
    const val = v(coalition);
    vCache.set(mask, val);
    return val;
  };

  const full = 1 << n;
  for (let mask = 0; mask < full; mask++) {
    const s = popcount(mask);
    const weight = (fact[s]! * fact[n - s - 1]!) / fact[n]!;
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) continue; // i ∉ S; measure i's marginal on S = mask
      const marginal = vOf(mask | (1 << i)) - vOf(mask);
      phi[players[i]!] = (phi[players[i]!] ?? 0) + weight * marginal;
    }
  }
  return phi;
}
