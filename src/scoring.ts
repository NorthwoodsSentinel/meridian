/**
 * Confidence scoring — pure functions, no I/O, so they are trivially testable.
 *
 * Two distinct numbers, kept separate on purpose:
 *
 *  - Per-claim `confidence` (0..1): assigned by the challenge strategy, expresses
 *    how sure the challenger is about the verdict it gave a single claim. Lives on
 *    each ChallengeOutcome.
 *
 *  - Result-level `confidenceScore` (0..1): trust in the whole claim set. This is
 *    kredence's exact formula — `(verified + 0.5 * unresolved) / total` — kept for
 *    parity so the semantics ("higher = more trustworthy subject") are unchanged.
 */
import type { ChallengeOutcome, Verdict } from "./types.ts";

export type VerdictTally = {
  verifiedCount: number;
  flaggedCount: number;
  unresolvedCount: number;
  total: number;
};

export function tallyVerdicts(outcomes: ReadonlyArray<{ verdict: Verdict }>): VerdictTally {
  let verifiedCount = 0;
  let flaggedCount = 0;
  let unresolvedCount = 0;
  for (const o of outcomes) {
    if (o.verdict === "verified") verifiedCount++;
    else if (o.verdict === "flagged") flaggedCount++;
    else unresolvedCount++;
  }
  return { verifiedCount, flaggedCount, unresolvedCount, total: outcomes.length };
}

/** Round to two decimal places, matching kredence's presentation. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Trust score for the claim set. Verified claims count fully, flagged count
 * zero, and unresolved count `unresolvedWeight` (default 0.5 = kredence parity).
 * A paid audit passes 0 so an unobserved control earns no credit. Empty set
 * scores 0 (nothing verified).
 */
export function computeConfidenceScore(
  outcomes: ReadonlyArray<{ verdict: Verdict }>,
  unresolvedWeight: number = 0.5,
): number {
  const { verifiedCount, unresolvedCount, total } = tallyVerdicts(outcomes);
  if (total === 0) return 0;
  return round2((verifiedCount + unresolvedWeight * unresolvedCount) / total);
}

/**
 * Mean per-claim confidence — a secondary signal describing how decisive the
 * challenger was across the run (distinct from how trustworthy the subject is).
 */
export function meanClaimConfidence(outcomes: ReadonlyArray<ChallengeOutcome>): number {
  if (outcomes.length === 0) return 0;
  const sum = outcomes.reduce((acc, o) => acc + o.confidence, 0);
  return round2(sum / outcomes.length);
}
