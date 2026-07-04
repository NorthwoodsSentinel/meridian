/**
 * Meridian — domain-agnostic adversarial-verification engine.
 *
 * The whole surface is defined here so any adapter (Rhizome member substrate,
 * enterprise security controls, hackathon repos) speaks the same vocabulary.
 *
 * Lineage: adapted from David Dao's `kredence` adversarial pipeline. The heart
 * kept intact — challenge every claim, sign the objection, emit a confidence
 * score. Everything web3-specific (onchain evidence, EIP-191 wallet signing,
 * Storacha/IPFS, hypercerts) was dropped. See DESIGN.md for the exact mapping.
 */

// ── Verdicts and challenge taxonomy ──────────────────────────────────────────

/** The outcome of adversarially challenging a single claim. */
export type Verdict = "verified" | "flagged" | "unresolved";

/**
 * Why a claim was challenged. Generalized away from kredence's web3-specific
 * set (which had `deployment`, `dead-link`) to domain-neutral categories that
 * fit a Rhizome trust attestation or an enterprise control just as well.
 */
export type ChallengeType =
  | "unsupported" // no evidence addresses the claim at all
  | "contradicted" // evidence directly refutes the claim
  | "vague" // claim states no specific, measurable outcome
  | "stale" // supporting evidence exists but is out of date
  | "attribution" // the actor/subject cannot be tied to the evidence
  | "overclaim"; // claimed magnitude exceeds what evidence supports

// ── Claims ───────────────────────────────────────────────────────────────────

/**
 * A machine-checkable assertion attached to a claim. When present, the
 * rule-based challenge strategy can deterministically verify or refute the
 * claim against evidence without any LLM or network call. When absent, the
 * strategy falls back to heuristics (self-reported metrics get flagged, etc.).
 *
 * `field` is a dot-path looked up across every evidence item's `data`.
 */
export type Assertion =
  | { kind: "exists"; field: string }
  | { kind: "equals"; field: string; value: string | number | boolean }
  | { kind: "atLeast"; field: string; value: number }
  | { kind: "atMost"; field: string; value: number }
  | { kind: "matches"; field: string; pattern: string }
  | { kind: "freshWithinDays"; field: string; days: number };

/** A single assertion of fact to be adversarially verified. */
export type Claim = {
  id: string;
  /** Human-readable statement of the claim. */
  text: string;
  /**
   * True when the claim originates from the subject's own words (a README, a
   * self-attestation, a vendor questionnaire) rather than independent evidence.
   * Self-reported metric claims with no corroborating evidence are flagged.
   */
  selfReported: boolean;
  /** Optional structured assertion enabling deterministic refutation. */
  assertion?: Assertion;
  /** Free-form domain metadata (e.g. member id, control id). Never trusted as evidence. */
  attributes?: Record<string, unknown>;
};

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * One normalized piece of evidence. `kind` is a domain label the adapter
 * chooses (e.g. "github-activity", "control-config", "member-attestation").
 * `data` is the flat/nested bag of fields that assertions look up by dot-path.
 */
export type EvidenceItem = {
  id: string;
  /** Which source/adapter produced this item. */
  source: string;
  kind: string;
  /** ISO-8601 timestamp of when this evidence reflects reality. Used for staleness. */
  observedAt: string;
  data: Record<string, unknown>;
};

/** The full evidence context for one subject, produced by an EvidenceAdapter. */
export type EvidenceBundle = {
  /** Opaque id of the thing being verified (a member, a repo, a control set). */
  subjectId: string;
  /** ISO-8601 timestamp of collection. */
  collectedAt: string;
  /** Which adapter assembled this bundle. */
  adapterId: string;
  items: EvidenceItem[];
  /** Sources the adapter tried but could not collect — surfaced, never hidden. */
  failures: Array<{ source: string; reason: string }>;
};

// ── Signing ──────────────────────────────────────────────────────────────────

/**
 * A detached signature over a canonical message. Local ed25519 (node:crypto) —
 * no wallets, no chain. `messageHash` lets a verifier confirm what was signed
 * without needing the original message inline.
 */
export type Signature = {
  algorithm: "ed25519";
  /** Base64 SPKI DER of the signer's public key. */
  publicKey: string;
  /** SHA-256 hex of the canonical message that was signed. */
  messageHash: string;
  /** Base64 detached signature. */
  signature: string;
};

// ── Adversarial output ───────────────────────────────────────────────────────

/** The result of challenging one claim. */
export type ChallengeOutcome = {
  claimId: string;
  claimText: string;
  verdict: Verdict;
  challengeType: ChallengeType;
  /** What the challenger found (or failed to find) in the evidence. */
  challengeEvidence: string;
  /** Required for `flagged`/`unresolved`; null for `verified`. Must cite specifics. */
  objection: string | null;
  /** 0..1 — the challenger's confidence in the verdict it assigned. */
  confidence: number;
};

/**
 * A signed objection receipt for a flagged (or unresolved) claim. This is the
 * kredence "signed adversarial log entry" generalized: anyone holding the
 * public key can verify the objection was issued by this engine and unaltered.
 */
export type SignedObjection = {
  claimId: string;
  challengeType: ChallengeType;
  objection: string;
  challengeEvidence: string;
  confidence: number;
  issuedAt: string;
  signature: Signature;
};

// ── Execution log (agent_log-style, kredence AgentLogger) ────────────────────

export type ExecutionPhase = "collect" | "challenge" | "score" | "sign" | "persist";

export type ExecutionLogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  phase: ExecutionPhase;
  action: string;
  details?: Record<string, unknown>;
};

// ── Final result ─────────────────────────────────────────────────────────────

/**
 * The signed, confidence-scored verification result. This is the whole point of
 * the engine — a portable, auditable receipt anyone can re-verify offline.
 */
export type VerificationResult = {
  runId: string;
  /** Human-readable label for what was verified. */
  subject: string;
  subjectId: string;
  adapterId: string;
  strategyId: string;
  evaluatedAt: string;
  outcomes: ChallengeOutcome[];
  verifiedCount: number;
  flaggedCount: number;
  unresolvedCount: number;
  /**
   * 0..1 trust score for the claim set as a whole.
   * `(verifiedCount + 0.5 * unresolvedCount) / totalClaims`, rounded to 2dp —
   * kredence's formula, kept for parity. See scoring.ts.
   */
  confidenceScore: number;
  /** One signed receipt per flagged/unresolved claim. */
  signedObjections: SignedObjection[];
  executionLog: ExecutionLogEntry[];
  /** Detached ed25519 signature over the canonical digest of this result. */
  signature: Signature;
};
