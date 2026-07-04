/**
 * RuleBasedChallengeStrategy — the shipped default adversary.
 *
 * Deterministic, hermetic (no LLM, no network), and therefore testable and safe
 * to run unsupervised. It mirrors kredence's adversarial intent — try to REFUTE
 * each claim against evidence, and only concede "verified" when an independent
 * source corroborates it — but does so with explicit rules instead of a model.
 *
 * Two paths:
 *   1. Claim carries a structured `assertion` → evaluate it against evidence.
 *      This is the deterministic heart: exists / equals / atLeast / atMost /
 *      matches / freshWithinDays each verify or flag with a cited objection.
 *   2. Claim has no assertion → heuristics. A self-reported claim that states a
 *      specific metric (contains a number) with nothing to corroborate it is
 *      flagged as unsupported — the same instinct as kredence's "specific metric
 *      appearing only on the project's own README gets flagged". Everything else
 *      genuinely indeterminate becomes `unresolved` (never a silent pass).
 */
import type { Assertion, Claim, ChallengeOutcome } from "../types.ts";
import type { ChallengeContext, ChallengeStrategy } from "./strategy.ts";
import { ageInDays, findField } from "./evidenceQuery.ts";

const CONFIDENCE = {
  strongVerified: 0.95,
  verified: 0.9,
  contradicted: 0.9,
  unsupportedMetric: 0.75,
  heuristicFlag: 0.6,
  unresolved: 0.5,
  typeMismatch: 0.4,
} as const;

/** A claim "states a metric" if its text contains a digit (a number, percentage, count). */
function statesMetric(text: string): boolean {
  return /\d/.test(text);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export class RuleBasedChallengeStrategy implements ChallengeStrategy {
  readonly id = "rule-based";

  challenge(claim: Claim, ctx: ChallengeContext): ChallengeOutcome {
    ctx.log.log("info", "challenge", "claim:start", {
      claimId: claim.id,
      hasAssertion: claim.assertion !== undefined,
    });

    const outcome = claim.assertion
      ? this.#evaluateAssertion(claim, claim.assertion, ctx)
      : this.#evaluateHeuristic(claim);

    ctx.log.log("info", "challenge", "claim:done", {
      claimId: claim.id,
      verdict: outcome.verdict,
      challengeType: outcome.challengeType,
    });
    return outcome;
  }

  #evaluateAssertion(claim: Claim, assertion: Assertion, ctx: ChallengeContext): ChallengeOutcome {
    const hit = findField(ctx.bundle, assertion.field);

    // No evidence addresses the field at all.
    if (!hit) {
      const metric = statesMetric(claim.text);
      if (claim.selfReported && metric) {
        return this.#make(claim, "flagged", "unsupported", CONFIDENCE.unsupportedMetric, {
          challengeEvidence: `No evidence source reports "${assertion.field}"; claim is self-reported and states a specific metric.`,
          objection: `Self-reported claim asserts "${assertion.field}" but no independent evidence item contains that field. A specific metric with zero corroboration is treated as unsupported.`,
        });
      }
      return this.#make(claim, "unresolved", "unsupported", CONFIDENCE.unresolved, {
        challengeEvidence: `No evidence source reports "${assertion.field}".`,
        objection: `Cannot confirm or deny: no evidence item provides "${assertion.field}". Evidence covering this field would resolve it.`,
      });
    }

    const { value, item } = hit;
    const cite = `evidence "${item.kind}" (source: ${item.source}, observed ${item.observedAt}) reports ${assertion.field}=${JSON.stringify(value)}`;

    switch (assertion.kind) {
      case "exists":
        return this.#make(claim, "verified", "unsupported", CONFIDENCE.verified, {
          challengeEvidence: `Field present: ${cite}.`,
          objection: null,
        });

      case "equals": {
        const matches = value === assertion.value;
        return matches
          ? this.#make(claim, "verified", "contradicted", CONFIDENCE.strongVerified, {
              challengeEvidence: `Exact match: ${cite}, expected ${JSON.stringify(assertion.value)}.`,
              objection: null,
            })
          : this.#make(claim, "flagged", "contradicted", CONFIDENCE.contradicted, {
              challengeEvidence: `Mismatch: ${cite}, claim expects ${JSON.stringify(assertion.value)}.`,
              objection: `Evidence contradicts the claim: ${assertion.field} is ${JSON.stringify(value)}, not ${JSON.stringify(assertion.value)}.`,
            });
      }

      case "atLeast": {
        const num = asNumber(value);
        if (num === undefined) return this.#typeMismatch(claim, assertion.field, value, "numeric");
        return num >= assertion.value
          ? this.#make(claim, "verified", "overclaim", CONFIDENCE.verified, {
              challengeEvidence: `Threshold met: ${cite} ≥ claimed ${assertion.value}.`,
              objection: null,
            })
          : this.#make(claim, "flagged", "overclaim", CONFIDENCE.contradicted, {
              challengeEvidence: `Below threshold: ${cite} < claimed ${assertion.value}.`,
              objection: `Overclaim: evidence shows ${assertion.field}=${num}, which is less than the claimed minimum of ${assertion.value}.`,
            });
      }

      case "atMost": {
        const num = asNumber(value);
        if (num === undefined) return this.#typeMismatch(claim, assertion.field, value, "numeric");
        return num <= assertion.value
          ? this.#make(claim, "verified", "overclaim", CONFIDENCE.verified, {
              challengeEvidence: `Within bound: ${cite} ≤ claimed ${assertion.value}.`,
              objection: null,
            })
          : this.#make(claim, "flagged", "overclaim", CONFIDENCE.contradicted, {
              challengeEvidence: `Exceeds bound: ${cite} > claimed ${assertion.value}.`,
              objection: `Overclaim: evidence shows ${assertion.field}=${num}, which exceeds the claimed maximum of ${assertion.value}.`,
            });
      }

      case "matches": {
        if (typeof value !== "string") {
          return this.#typeMismatch(claim, assertion.field, value, "string");
        }
        let re: RegExp;
        try {
          re = new RegExp(assertion.pattern);
        } catch {
          return this.#make(claim, "unresolved", "vague", CONFIDENCE.unresolved, {
            challengeEvidence: `Assertion pattern "${assertion.pattern}" is not a valid regular expression.`,
            objection: `Cannot evaluate: the claim's match pattern "${assertion.pattern}" is invalid.`,
          });
        }
        return re.test(value)
          ? this.#make(claim, "verified", "contradicted", CONFIDENCE.verified, {
              challengeEvidence: `Pattern matched: ${cite} matches /${assertion.pattern}/.`,
              objection: null,
            })
          : this.#make(claim, "flagged", "contradicted", CONFIDENCE.contradicted, {
              challengeEvidence: `Pattern did not match: ${cite} fails /${assertion.pattern}/.`,
              objection: `Evidence contradicts the claim: ${assertion.field}=${JSON.stringify(value)} does not match the required pattern /${assertion.pattern}/.`,
            });
      }

      case "freshWithinDays": {
        const age = ageInDays(item.observedAt);
        return age <= assertion.days
          ? this.#make(claim, "verified", "stale", CONFIDENCE.verified, {
              challengeEvidence: `Fresh: ${cite}, observed ${age} day(s) ago ≤ ${assertion.days}.`,
              objection: null,
            })
          : this.#make(claim, "flagged", "stale", CONFIDENCE.contradicted, {
              challengeEvidence: `Stale: ${cite}, observed ${age} day(s) ago > ${assertion.days}.`,
              objection: `Stale evidence: the supporting evidence for ${assertion.field} was observed ${age} days ago, exceeding the claimed freshness window of ${assertion.days} days.`,
            });
      }

      default: {
        // Exhaustiveness guard — a new Assertion kind must be handled explicitly.
        const _never: never = assertion;
        throw new Error(`Unhandled assertion kind: ${JSON.stringify(_never)}`);
      }
    }
  }

  #evaluateHeuristic(claim: Claim): ChallengeOutcome {
    if (claim.selfReported && statesMetric(claim.text)) {
      return this.#make(claim, "flagged", "unsupported", CONFIDENCE.heuristicFlag, {
        challengeEvidence: `Self-reported claim states a specific metric but carries no structured assertion to corroborate against evidence.`,
        objection: `Self-reported metric with no verifiable assertion or corroborating evidence. Attach a structured assertion or independent evidence to substantiate it.`,
      });
    }
    return this.#make(claim, "unresolved", "vague", CONFIDENCE.unresolved, {
      challengeEvidence: `Claim carries no structured assertion and states no specific, checkable metric.`,
      objection: `Cannot confirm or deny: the claim is not framed as a specific, measurable assertion. Restate it with a checkable predicate to resolve.`,
    });
  }

  #typeMismatch(
    claim: Claim,
    field: string,
    value: unknown,
    expected: string,
  ): ChallengeOutcome {
    return this.#make(claim, "unresolved", "vague", CONFIDENCE.typeMismatch, {
      challengeEvidence: `Type mismatch: ${field}=${JSON.stringify(value)} is not ${expected}, so the assertion cannot be evaluated.`,
      objection: `Cannot evaluate: evidence field ${field} is ${JSON.stringify(value)}, but a ${expected} value is required to test this claim.`,
    });
  }

  #make(
    claim: Claim,
    verdict: ChallengeOutcome["verdict"],
    challengeType: ChallengeOutcome["challengeType"],
    confidence: number,
    parts: { challengeEvidence: string; objection: string | null },
  ): ChallengeOutcome {
    return {
      claimId: claim.id,
      claimText: claim.text,
      verdict,
      challengeType,
      challengeEvidence: parts.challengeEvidence,
      objection: parts.objection,
      confidence,
    };
  }
}
