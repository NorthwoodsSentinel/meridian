/**
 * T-098 — the invariant the cross-vendor council demanded, as an executable gate:
 *   verifyResult(r).resultValid  ⟹  recompute(r.outcomes) == r.summary
 *
 * The old verifier checked only the signature and NEVER re-derived the summary,
 * so a receipt whose score/counts contradicted its own outcomes verified green.
 * These property tests fail against that old behavior (the count-tamper case
 * especially — counts weren't even signed) and pass against the redesign.
 */
import { test, expect } from "bun:test";
import { Ed25519Signer } from "../src/signing.ts";
import { buildResultDigest } from "../src/engine.ts";
import { verifyResult } from "../src/verify.ts";
import { computeConfidenceScore, tallyVerdicts } from "../src/scoring.ts";
import type { ChallengeOutcome, VerificationResult, Verdict } from "../src/types.ts";

const VERDICTS: Verdict[] = ["verified", "flagged", "unresolved"];

function outcome(i: number, verdict: Verdict): ChallengeOutcome {
  return {
    claimId: `c${i}`,
    claimText: `claim ${i}`,
    verdict,
    challengeType: "vague",
    challengeEvidence: `evidence ${i}`,
    objection: verdict === "verified" ? null : `objection ${i}`,
    confidence: 0.5,
  };
}

/** Build a correctly-signed result exactly as the engine does (outcomes + weight signed). */
function makeSignedResult(
  verdicts: Verdict[],
  unresolvedWeight: number,
  signer: Ed25519Signer,
): VerificationResult {
  const outcomes = verdicts.map((v, i) => outcome(i, v));
  const tally = tallyVerdicts(outcomes);
  const base = {
    runId: "run-1",
    subject: "s",
    subjectId: "sid",
    adapterId: "a",
    strategyId: "st",
    unresolvedWeight,
    outcomes,
  };
  const signature = signer.sign(buildResultDigest(base));
  return {
    ...base,
    evaluatedAt: "2026-07-06T00:00:00.000Z",
    verifiedCount: tally.verifiedCount,
    flaggedCount: tally.flaggedCount,
    unresolvedCount: tally.unresolvedCount,
    confidenceScore: computeConfidenceScore(outcomes, unresolvedWeight),
    signedObjections: [],
    executionLog: [],
    signature,
  };
}

function randomVerdicts(n: number): Verdict[] {
  return Array.from({ length: n }, () => VERDICTS[Math.floor(Math.random() * VERDICTS.length)]!);
}

test("property: honest receipts verify, and the re-derived summary equals the stored one", () => {
  const signer = Ed25519Signer.generate();
  for (let i = 0; i < 100; i++) {
    const n = 1 + Math.floor(Math.random() * 8);
    const weight = Math.random() < 0.5 ? 0.5 : 0;
    const r = makeSignedResult(randomVerdicts(n), weight, signer);
    const v = verifyResult(r);
    expect(v.signatureValid).toBe(true);
    expect(v.summaryMatches).toBe(true);
    expect(v.resultValid).toBe(true);
    expect(v.derived.confidenceScore).toBe(r.confidenceScore);
    expect(v.derived.flaggedCount).toBe(r.flaggedCount);
  }
});

test("property: a lied confidenceScore fails the gate (sig intact, re-derivation catches it)", () => {
  const signer = Ed25519Signer.generate();
  for (let i = 0; i < 100; i++) {
    const n = 1 + Math.floor(Math.random() * 8);
    const r = makeSignedResult(randomVerdicts(n), 0.5, signer);
    const lied: VerificationResult = { ...r, confidenceScore: r.confidenceScore === 1 ? 0 : 1 };
    const v = verifyResult(lied);
    expect(v.signatureValid).toBe(true); // outcomes + weight untouched → signature still valid
    expect(v.summaryMatches).toBe(false); // the re-derivation exposes the lie
    expect(v.resultValid).toBe(false); // the gate rejects it
  }
});

test("a tampered count fails the gate (counts weren't even signed before)", () => {
  const signer = Ed25519Signer.generate();
  const r = makeSignedResult(["flagged", "flagged", "verified"], 0.5, signer);
  const lied: VerificationResult = { ...r, verifiedCount: 3, flaggedCount: 0 };
  const v = verifyResult(lied);
  expect(v.summaryMatches).toBe(false);
  expect(v.resultValid).toBe(false);
});

test("the exact council example: score 1.0 over all-flagged outcomes cannot verify", () => {
  const signer = Ed25519Signer.generate();
  const r = makeSignedResult(["flagged", "flagged", "flagged"], 0.5, signer);
  expect(r.confidenceScore).toBe(0); // honest score for all-flagged
  const lied: VerificationResult = { ...r, confidenceScore: 1.0, verifiedCount: 3, flaggedCount: 0 };
  expect(verifyResult(lied).resultValid).toBe(false);
});

test("tampering a signed outcome breaks the signature", () => {
  const signer = Ed25519Signer.generate();
  const r = makeSignedResult(["flagged", "verified"], 0.5, signer);
  const lied: VerificationResult = {
    ...r,
    outcomes: r.outcomes.map((o, i) => (i === 0 ? { ...o, verdict: "verified" as Verdict } : o)),
  };
  const v = verifyResult(lied);
  expect(v.signatureValid).toBe(false); // outcomes are in the signed digest
  expect(v.resultValid).toBe(false);
});
