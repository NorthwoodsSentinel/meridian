import { describe, expect, test } from "bun:test";
import {
  computeConfidenceScore,
  meanClaimConfidence,
  round2,
  tallyVerdicts,
} from "../src/scoring.ts";
import type { ChallengeOutcome, Verdict } from "../src/types.ts";

function v(verdict: Verdict): { verdict: Verdict } {
  return { verdict };
}

describe("tallyVerdicts", () => {
  test("counts each verdict class and total", () => {
    const t = tallyVerdicts([v("verified"), v("verified"), v("flagged"), v("unresolved")]);
    expect(t).toEqual({ verifiedCount: 2, flaggedCount: 1, unresolvedCount: 1, total: 4 });
  });

  test("empty set is all zeros", () => {
    expect(tallyVerdicts([])).toEqual({
      verifiedCount: 0,
      flaggedCount: 0,
      unresolvedCount: 0,
      total: 0,
    });
  });
});

describe("computeConfidenceScore (kredence formula parity)", () => {
  test("all verified → 1.0", () => {
    expect(computeConfidenceScore([v("verified"), v("verified")])).toBe(1);
  });

  test("all flagged → 0", () => {
    expect(computeConfidenceScore([v("flagged"), v("flagged")])).toBe(0);
  });

  test("unresolved counts half", () => {
    // (1 verified + 0.5*1 unresolved) / 2 = 0.75
    expect(computeConfidenceScore([v("verified"), v("unresolved")])).toBe(0.75);
  });

  test("mixed set matches (verified + 0.5*unresolved)/total, rounded 2dp", () => {
    // 3 verified, 4 flagged, 1 unresolved, total 8 → (3 + 0.5)/8 = 0.4375 → 0.44
    const outcomes = [
      v("verified"),
      v("verified"),
      v("verified"),
      v("flagged"),
      v("flagged"),
      v("flagged"),
      v("flagged"),
      v("unresolved"),
    ];
    expect(computeConfidenceScore(outcomes)).toBe(0.44);
  });

  test("empty set scores 0 (nothing verified)", () => {
    expect(computeConfidenceScore([])).toBe(0);
  });
});

describe("round2", () => {
  test("rounds to two decimals", () => {
    expect(round2(0.4375)).toBe(0.44);
    expect(round2(0.126)).toBe(0.13);
    expect(round2(1)).toBe(1);
  });
});

describe("meanClaimConfidence", () => {
  test("averages per-claim confidence", () => {
    const outcomes = [
      { confidence: 0.9 },
      { confidence: 0.5 },
    ] as ChallengeOutcome[];
    expect(meanClaimConfidence(outcomes)).toBe(0.7);
  });

  test("empty → 0", () => {
    expect(meanClaimConfidence([])).toBe(0);
  });
});
