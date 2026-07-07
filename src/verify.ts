/**
 * Independent re-verification of a signed VerificationResult. Anyone holding the
 * result JSON (and nothing else — the public key is embedded in each signature)
 * can confirm the result and every objection are authentic and unaltered. This
 * is the payoff of dropping the chain: verification is pure local crypto.
 */
import type { VerificationResult } from "./types.ts";
import { verifySignature } from "./signing.ts";
import { buildResultDigest, buildObjectionMessage } from "./engine.ts";
import { computeConfidenceScore, tallyVerdicts } from "./scoring.ts";

export type ResultVerification = {
  /**
   * The gate. TRUE only when the signature is authentic AND the stored summary
   * equals what the signed outcomes re-derive. A receipt whose score/counts
   * contradict its own outcomes fails here — that is the whole point of the
   * redesign (T-098): "verified" now means "correct", not just "transmitted intact".
   */
  resultValid: boolean;
  /** The ed25519 signature over the digest (outcomes + weight + metadata) is authentic. */
  signatureValid: boolean;
  /** The stored summary (confidenceScore + the three counts) equals the re-derivation. */
  summaryMatches: boolean;
  /**
   * The authoritative summary, RE-DERIVED from the signed outcomes. Trust THIS,
   * not the stored `result.confidenceScore`/counts — those are an unsigned
   * convenience copy that this function has just confirmed (or rejected).
   */
  derived: {
    verifiedCount: number;
    flaggedCount: number;
    unresolvedCount: number;
    confidenceScore: number;
  };
  /** Every signed objection's signature is valid. */
  objectionsValid: boolean;
  /** Per-objection validity, keyed by claimId. */
  objectionResults: Array<{ claimId: string; valid: boolean }>;
};

export function verifyResult(result: VerificationResult): ResultVerification {
  // 1. Signature authenticates the ATOMIC facts: outcomes + unresolvedWeight + metadata.
  const signatureValid = verifySignature(result.signature, buildResultDigest(result));

  // 2. RE-DERIVE the summary from those signed facts and require the stored
  //    summary to agree. This is the half the old verifier was missing: a score
  //    or count that contradicts the outcomes it summarizes must not verify.
  //    Invariant: verifyResult(r).resultValid ⟹ recompute(r.outcomes) == r.summary.
  const tally = tallyVerdicts(result.outcomes);
  const derived = {
    verifiedCount: tally.verifiedCount,
    flaggedCount: tally.flaggedCount,
    unresolvedCount: tally.unresolvedCount,
    confidenceScore: computeConfidenceScore(result.outcomes, result.unresolvedWeight),
  };
  const summaryMatches =
    result.verifiedCount === derived.verifiedCount &&
    result.flaggedCount === derived.flaggedCount &&
    result.unresolvedCount === derived.unresolvedCount &&
    result.confidenceScore === derived.confidenceScore;

  const objectionResults = result.signedObjections.map((obj) => {
    const message = buildObjectionMessage({
      runId: result.runId,
      claimId: obj.claimId,
      challengeType: obj.challengeType,
      verdict: result.outcomes.find((o) => o.claimId === obj.claimId)?.verdict ?? "",
      objection: obj.objection,
      challengeEvidence: obj.challengeEvidence,
      confidence: obj.confidence,
      issuedAt: obj.issuedAt,
    });
    return { claimId: obj.claimId, valid: verifySignature(obj.signature, message) };
  });

  return {
    resultValid: signatureValid && summaryMatches,
    signatureValid,
    summaryMatches,
    derived,
    objectionsValid: objectionResults.every((r) => r.valid),
    objectionResults,
  };
}
