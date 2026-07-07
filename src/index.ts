/**
 * Meridian — public API surface.
 *
 * A domain-agnostic adversarial-verification engine: hand it Claims plus an
 * EvidenceBundle (via any EvidenceAdapter), and it challenges every claim,
 * signs an objection for anything that fails, and returns a confidence-scored,
 * ed25519-signed result with a full execution log.
 */

// Core types
export type {
  Assertion,
  Claim,
  ChallengeOutcome,
  ChallengeType,
  EvidenceBundle,
  EvidenceItem,
  ExecutionLogEntry,
  ExecutionPhase,
  Signature,
  SignedObjection,
  Verdict,
  VerificationResult,
} from "./types.ts";

// Engine
export { MeridianEngine, runVerification, buildResultDigest } from "./engine.ts";
export type { EngineOptions, VerifyInput } from "./engine.ts";

// Re-verification
export { verifyResult } from "./verify.ts";
export type { ResultVerification } from "./verify.ts";

// Signing
export { Ed25519Signer, verifySignature, canonicalize, sha256Hex } from "./signing.ts";
export type { Signer } from "./signing.ts";

// Scoring
export {
  computeConfidenceScore,
  meanClaimConfidence,
  tallyVerdicts,
  round2,
} from "./scoring.ts";
export type { VerdictTally } from "./scoring.ts";

// Execution log
export { ExecutionLog } from "./log.ts";
export type { LogListener } from "./log.ts";

// Challenge strategies
export { RuleBasedChallengeStrategy } from "./challenge/ruleBased.ts";
export type {
  ChallengeStrategy,
  ChallengeContext,
  Tool,
  ToolRegistry,
} from "./challenge/strategy.ts";
export { findField, getPath, ageInDays } from "./challenge/evidenceQuery.ts";
export type { FieldHit } from "./challenge/evidenceQuery.ts";

// Evidence adapters
export type { EvidenceAdapter, EvidenceQuery } from "./evidence/adapter.ts";
export { LocalJsonEvidenceAdapter } from "./evidence/localJson.ts";
export type { LocalJsonSource } from "./evidence/localJson.ts";

// Rhizome-membership adapter (cooperative trust)
export {
  RhizomeMembershipAdapter,
  buildMembershipClaims,
} from "./evidence/rhizome.ts";
export type {
  MemberSubstrateSource,
  SelfReportedMetric,
  BuildMembershipClaimsOptions,
} from "./evidence/rhizome.ts";
export {
  DEFAULT_MEMBERSHIP_POLICY,
} from "./rhizome/types.ts";
// Live Cistern loader — the production wire (Cistern intake → Meridian trust)
export { cisternMemberLoader } from "./evidence/cistern.ts";
export type { CisternLoaderConfig } from "./evidence/cistern.ts";
export type {
  MemberSubstrate,
  PeerAttestation,
  ContributionReceipt,
  ParticipationLog,
  MembershipPolicy,
} from "./rhizome/types.ts";

// Receipt store
export type { ReceiptStore } from "./store/receiptStore.ts";
export { JsonFileReceiptStore } from "./store/jsonFileStore.ts";
