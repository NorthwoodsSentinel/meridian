/**
 * MeridianEngine — the adversarial-verification core.
 *
 * Maps directly onto kredence's `runAdversarialAgent` + the deterministic half of
 * its Synthesis agent, generalized and stripped of all web3 coupling:
 *
 *   for each claim:
 *     1. challenge it with the pluggable strategy (kredence: challengeClaims LLM)
 *     2. if flagged/unresolved, sign a detached objection receipt
 *          (kredence: signAdversarialLog, EIP-191 → here: local ed25519)
 *   then:
 *     3. compute the confidence score (kredence's exact formula)
 *     4. sign the whole result digest
 *     5. optionally persist to a ReceiptStore (kredence: Storacha uploadJSON)
 *
 * Every step appends to an execution log so the run is fully auditable.
 */
import { randomUUID } from "node:crypto";
import type {
  Claim,
  ChallengeOutcome,
  EvidenceBundle,
  SignedObjection,
  VerificationResult,
} from "./types.ts";
import { ExecutionLog, type LogListener } from "./log.ts";
import { canonicalize, type Signer } from "./signing.ts";
import { computeConfidenceScore, tallyVerdicts } from "./scoring.ts";
import type { ChallengeContext, ChallengeStrategy, ToolRegistry } from "./challenge/strategy.ts";
import type { ReceiptStore } from "./store/receiptStore.ts";
import type { EvidenceAdapter, EvidenceQuery } from "./evidence/adapter.ts";

export type EngineOptions = {
  strategy: ChallengeStrategy;
  signer: Signer;
  /** Optional capabilities passed through to the challenge strategy. */
  tools?: ToolRegistry;
  /** Optional persistence for results + signed objections. */
  store?: ReceiptStore;
  /**
   * Weight an unresolved verdict contributes to the confidence score (0..1).
   * Defaults to 0.5 (kredence parity — co-op unchanged). A paid audit should set
   * this to 0 so "no evidence" earns no trust rather than half credit.
   */
  unresolvedWeight?: number;
  /** Optional live log listener (dashboard / progress notify). */
  onLog?: LogListener;
  /** Mirror the execution log to the console. Default false. */
  echo?: boolean;
};

export type VerifyInput = {
  /** Human-readable label for what is being verified. */
  subject: string;
  claims: Claim[];
  evidence: EvidenceBundle;
};

/**
 * Receipt binding version. Bump when the signed digest / objection message shape
 * changes so an old receipt can't be re-verified against new binding rules (and
 * vice-versa) — the version is part of the signed bytes, so a mismatch fails
 * verification loudly instead of silently mis-validating.
 */
export const RECEIPT_VERSION = 3;

/**
 * The stable subset of a result that the signature covers — the ATOMIC facts
 * only: the per-claim outcomes and the `unresolvedWeight`. The summary
 * (`confidenceScore` and the three counts) is deliberately NOT signed here: it
 * is a pure function of the signed outcomes + weight, so `verifyResult`
 * re-derives it rather than trusting a stored number. This is what makes a
 * lying summary ("score 1.0 over all-flagged outcomes") *unverifiable* instead
 * of merely unlikely — the illegal state cannot pass verification.
 *
 * Tampering with any verdict, type, per-claim confidence, the weight, the
 * subject, or a claim's text is detectable via the signature; tampering with the
 * summary is detectable via re-derivation.
 */
export function buildResultDigest(
  result: Pick<
    VerificationResult,
    "runId" | "subject" | "subjectId" | "adapterId" | "strategyId" | "unresolvedWeight" | "outcomes"
  >,
): string {
  return canonicalize({
    v: RECEIPT_VERSION,
    runId: result.runId,
    subject: result.subject,
    subjectId: result.subjectId,
    adapterId: result.adapterId,
    strategyId: result.strategyId,
    unresolvedWeight: result.unresolvedWeight,
    outcomes: result.outcomes.map((o) => ({
      claimId: o.claimId,
      claimText: o.claimText,
      verdict: o.verdict,
      challengeType: o.challengeType,
      confidence: o.confidence,
    })),
  });
}

/**
 * The signed bytes of a detached objection. Built here and reused by verify.ts
 * so the sign path and the re-verify path cannot drift. Binds the cited evidence
 * text and confidence in addition to the verdict — a receipt consumer treats
 * those as authoritative, so they must be tamper-evident.
 */
export function buildObjectionMessage(fields: {
  runId: string;
  claimId: string;
  challengeType: string;
  verdict: string;
  objection: string;
  challengeEvidence: string;
  confidence: number;
  issuedAt: string;
}): string {
  return canonicalize({
    v: RECEIPT_VERSION,
    runId: fields.runId,
    claimId: fields.claimId,
    challengeType: fields.challengeType,
    verdict: fields.verdict,
    objection: fields.objection,
    challengeEvidence: fields.challengeEvidence,
    confidence: fields.confidence,
    issuedAt: fields.issuedAt,
  });
}

export class MeridianEngine {
  #opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.#opts = opts;
  }

  async verify(input: VerifyInput): Promise<VerificationResult> {
    const { strategy, signer, store } = this.#opts;
    const log = new ExecutionLog({
      ...(this.#opts.onLog ? { onEntry: this.#opts.onLog } : {}),
      echo: this.#opts.echo ?? false,
    });
    const runId = randomUUID();

    log.log("info", "collect", "run:start", {
      runId,
      subject: input.subject,
      claimCount: input.claims.length,
      evidenceItems: input.evidence.items.length,
      evidenceFailures: input.evidence.failures.length,
    });
    for (const failure of input.evidence.failures) {
      log.log("warn", "collect", "evidence:source-failed", failure);
    }

    const ctx: ChallengeContext = {
      bundle: input.evidence,
      tools: this.#opts.tools ?? {},
      log,
    };

    // ── 1 + 2: challenge each claim, sign objections for flagged/unresolved ──
    const outcomes: ChallengeOutcome[] = [];
    const signedObjections: SignedObjection[] = [];

    for (const claim of input.claims) {
      let outcome: ChallengeOutcome;
      try {
        outcome = await strategy.challenge(claim, ctx);
      } catch (err) {
        // A strategy that throws must not sink the run — the claim becomes an
        // explicit unresolved with the error cited, never a silent pass.
        const reason = err instanceof Error ? err.message : String(err);
        log.log("error", "challenge", "claim:strategy-error", { claimId: claim.id, reason });
        outcome = {
          claimId: claim.id,
          claimText: claim.text,
          verdict: "unresolved",
          challengeType: "vague",
          challengeEvidence: `Challenge strategy threw: ${reason}`,
          objection: `Could not evaluate this claim — the challenge strategy errored. Treat as unresolved pending re-run.`,
          confidence: 0,
        };
      }
      outcomes.push(outcome);

      if (outcome.verdict !== "verified") {
        const objection = outcome.objection ?? "Flagged — see challenge evidence.";
        const issuedAt = new Date().toISOString();
        const message = buildObjectionMessage({
          runId,
          claimId: outcome.claimId,
          challengeType: outcome.challengeType,
          verdict: outcome.verdict,
          objection,
          challengeEvidence: outcome.challengeEvidence,
          confidence: outcome.confidence,
          issuedAt,
        });
        log.log("info", "sign", "objection:signing", { claimId: outcome.claimId });
        signedObjections.push({
          claimId: outcome.claimId,
          challengeType: outcome.challengeType,
          objection,
          challengeEvidence: outcome.challengeEvidence,
          confidence: outcome.confidence,
          issuedAt,
          signature: signer.sign(message),
        });
      }
    }

    // ── 3: score ─────────────────────────────────────────────────────────────
    const unresolvedWeight = this.#opts.unresolvedWeight ?? 0.5;
    const tally = tallyVerdicts(outcomes);
    const confidenceScore = computeConfidenceScore(outcomes, unresolvedWeight);
    log.log("info", "score", "score:computed", {
      verified: tally.verifiedCount,
      flagged: tally.flaggedCount,
      unresolved: tally.unresolvedCount,
      confidenceScore,
    });

    // ── 4: sign the whole result digest ──────────────────────────────────────
    const digestSource = {
      runId,
      subject: input.subject,
      subjectId: input.evidence.subjectId,
      adapterId: input.evidence.adapterId,
      strategyId: strategy.id,
      unresolvedWeight,
      outcomes,
    };
    const signature = signer.sign(buildResultDigest(digestSource));
    log.log("info", "sign", "result:signed", { signer: signer.publicKeyBase64 });

    const result: VerificationResult = {
      runId,
      subject: input.subject,
      subjectId: input.evidence.subjectId,
      adapterId: input.evidence.adapterId,
      strategyId: strategy.id,
      evaluatedAt: new Date().toISOString(),
      outcomes,
      verifiedCount: tally.verifiedCount,
      flaggedCount: tally.flaggedCount,
      unresolvedCount: tally.unresolvedCount,
      confidenceScore,
      unresolvedWeight,
      signedObjections,
      executionLog: log.entries(),
      signature,
    };

    // ── 5: persist ───────────────────────────────────────────────────────────
    if (store) {
      try {
        const ref = await store.save(result);
        log.log("info", "persist", "result:stored", { ref });
      } catch (err) {
        // Persistence failure is non-fatal — the caller still gets the result.
        log.log("warn", "persist", "result:store-failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.log("info", "persist", "run:done", { runId, confidenceScore });
    // The stored/returned executionLog is a snapshot; refresh it to include the
    // final persist/score entries emitted after the initial capture above.
    return { ...result, executionLog: log.entries() };
  }
}

/**
 * Convenience one-shot: collect evidence via an adapter, then verify. Mirrors
 * kredence's Evidence → Adversarial handoff without the intermediate storage hop.
 */
export async function runVerification(args: {
  subject: string;
  claims: Claim[];
  adapter: EvidenceAdapter;
  query: EvidenceQuery;
  engine: MeridianEngine;
}): Promise<VerificationResult> {
  const evidence = await args.adapter.collect(args.query);
  return args.engine.verify({ subject: args.subject, claims: args.claims, evidence });
}
