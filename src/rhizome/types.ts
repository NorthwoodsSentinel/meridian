/**
 * Rhizome member-substrate types — the normalized shape the membership adapter
 * consumes. This describes a co-op *member's own substrate*: the peer vouches,
 * contribution receipts, and participation history that the Meridian engine will
 * adversarially challenge to compute portable trust.
 *
 * These types are deliberately source-agnostic. Today the substrate arrives as
 * plain JSON (a file or an inline object). Tomorrow the *same shape* can be
 * produced by a Cistern episode reader, the daemon's canonical store, or an
 * ATProto/DID resolver — none of which requires touching the adapter, because
 * the adapter only ever sees a `MemberSubstrate`. See RHIZOME-WIRING.md.
 */

/** A peer vouching for a member. The independent-evidence half of trust. */
export type PeerAttestation = {
  /** Member id/handle of the peer doing the vouching. */
  voucher: string;
  /** Member id/handle being vouched for (the subject of this attestation). */
  subject: string;
  /** Free-text vouch. A later LLM challenge strategy can judge this directly. */
  statement: string;
  /** ISO-8601 time the attestation was made. Becomes the evidence `observedAt`. */
  observedAt: string;
};

/** A receipt that a member contributed something concrete to the co-op. */
export type ContributionReceipt = {
  /** Human-readable description of what was contributed. */
  what: string;
  /** Stable id/hash of the contribution receipt (dedupe + provenance anchor). */
  receiptHash: string;
  /** ISO-8601 time the contribution landed. Drives `last_contribution` freshness. */
  observedAt: string;
};

/** A logged participation event (a meeting, a review, a shift, a governance vote). */
export type ParticipationLog = {
  /** What the member participated in. */
  activity: string;
  /** ISO-8601 time of the participation event. */
  observedAt: string;
};

/**
 * The full normalized substrate for one co-op member. This is the adapter's
 * input contract — swap the *producer* (Cistern / daemon / ATProto) freely as
 * long as it yields this shape.
 */
export type MemberSubstrate = {
  /** Stable member id/handle. Should match the verification query's subjectId. */
  memberId: string;
  peerAttestations: PeerAttestation[];
  contributionReceipts: ContributionReceipt[];
  participationLogs: ParticipationLog[];
};

/**
 * The co-op's membership policy — the two thresholds DESIGN.md names, surfaced
 * as data so they are Rob's to tune, not buried in code. Defaults below.
 */
export type MembershipPolicy = {
  /** Minimum distinct peer vouches to be considered a member in good standing. */
  minVouches: number;
  /** A contribution within this many days counts as "still active". */
  freshnessDays: number;
};

/** Current co-op defaults. Documented in RHIZOME-WIRING.md — easy to change. */
export const DEFAULT_MEMBERSHIP_POLICY: MembershipPolicy = {
  minVouches: 3,
  freshnessDays: 90,
};
