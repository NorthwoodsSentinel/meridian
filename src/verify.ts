/**
 * Independent re-verification of a signed VerificationResult. Anyone holding the
 * result JSON (and nothing else — the public key is embedded in each signature)
 * can confirm the result and every objection are authentic and unaltered. This
 * is the payoff of dropping the chain: verification is pure local crypto.
 */
import type { VerificationResult } from "./types.ts";
import { canonicalize, verifySignature } from "./signing.ts";
import { buildResultDigest } from "./engine.ts";

export type ResultVerification = {
  /** The top-level result signature is valid over its digest. */
  resultValid: boolean;
  /** Every signed objection's signature is valid. */
  objectionsValid: boolean;
  /** Per-objection validity, keyed by claimId. */
  objectionResults: Array<{ claimId: string; valid: boolean }>;
};

export function verifyResult(result: VerificationResult): ResultVerification {
  const resultValid = verifySignature(result.signature, buildResultDigest(result));

  const objectionResults = result.signedObjections.map((obj) => {
    const message = canonicalize({
      runId: result.runId,
      claimId: obj.claimId,
      challengeType: obj.challengeType,
      verdict: result.outcomes.find((o) => o.claimId === obj.claimId)?.verdict ?? null,
      objection: obj.objection,
      issuedAt: obj.issuedAt,
    });
    return { claimId: obj.claimId, valid: verifySignature(obj.signature, message) };
  });

  return {
    resultValid,
    objectionsValid: objectionResults.every((r) => r.valid),
    objectionResults,
  };
}
