/**
 * ChallengeStrategy — the pluggable adversary.
 *
 * kredence's adversary was a single LLM call (`challengeClaims`). Meridian keeps
 * the same contract (in: claim + evidence, out: verdict + objection + confidence)
 * but makes the adversary an interface. The shipped default is deterministic and
 * hermetic (RuleBasedChallengeStrategy). An LLM-backed strategy — or one that
 * calls out to live tools — can be dropped in later without touching the engine.
 *
 * The `tools` registry is the "any tool it's given" seam: a strategy that wants
 * to probe a URL for liveness, or ask a model, receives those capabilities here
 * rather than importing them directly. The default strategy uses no tools.
 */
import type { Claim, ChallengeOutcome, EvidenceBundle } from "../types.ts";
import type { ExecutionLog } from "../log.ts";

/** A named capability a strategy may invoke. Kept intentionally loose. */
export type Tool = (input: unknown) => Promise<unknown>;
export type ToolRegistry = Record<string, Tool>;

export type ChallengeContext = {
  bundle: EvidenceBundle;
  tools: ToolRegistry;
  log: ExecutionLog;
};

export interface ChallengeStrategy {
  /** Stable identifier recorded on the result for provenance. */
  readonly id: string;
  challenge(claim: Claim, ctx: ChallengeContext): Promise<ChallengeOutcome> | ChallengeOutcome;
}
