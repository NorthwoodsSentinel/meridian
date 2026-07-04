/**
 * RhizomeMembershipAdapter — the first real Meridian adapter: it turns a co-op
 * member's substrate into an EvidenceBundle the engine can adversarially
 * challenge. The signed result the engine returns *is* the member's portable
 * trust receipt — a thing they carry between cooperatives, re-verifiable offline.
 *
 * The engine never learns it is doing "trust". It sees claims + evidence, exactly
 * as it does for the enterprise-audit demo. All the co-op-specific knowledge lives
 * in this one file, behind the identical `EvidenceAdapter` seam.
 *
 * SOURCE IS PLUGGABLE. This adapter never fetches. It is handed a
 * `MemberSubstrateSource` that yields a normalized `MemberSubstrate`:
 *   - `{ inline }`   — a substrate object already in memory (tests, demo).
 *   - `{ filePath }` — a JSON file on disk (demo fixtures).
 *   - `{ load }`     — an async loader. THIS is the real seam: a Cistern episode
 *                      reader, the daemon canonical store, or an ATProto/DID
 *                      resolver drops in here without touching this adapter.
 *
 * Normalization, per DESIGN.md:
 *   - each PeerAttestation   → EvidenceItem kind "peer-attestation"
 *   - each ContributionReceipt → EvidenceItem kind "contribution-receipt"
 *   - each ParticipationLog  → EvidenceItem kind "participation-log"
 *     (`observedAt` carried straight through from the substrate event time)
 *
 * PLUS two *derived rollup* items so the membership assertions DESIGN.md names
 * (`atLeast field:"vouches"`, `freshWithinDays field:"last_contribution"`) have a
 * field to bind to. Deriving aggregates from raw entries is normalization, not
 * fabrication — the rollups cite exactly what they summarize and are marked
 * `derived: true`:
 *   - a "peer-attestation" rollup carrying `vouches` = count of DISTINCT vouchers
 *     (a peer vouching twice is still one vouch — the trust hygiene the co-op wants),
 *     observedAt = the most recent attestation.
 *   - a "contribution-receipt" rollup carrying `last_contribution` (ISO of the most
 *     recent receipt) + `contribution_count`, observedAt = that most recent receipt
 *     time, so `freshWithinDays` measures real staleness.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Assertion, Claim, EvidenceBundle, EvidenceItem } from "../types.ts";
import type { EvidenceAdapter, EvidenceQuery } from "./adapter.ts";
import {
  DEFAULT_MEMBERSHIP_POLICY,
  type MemberSubstrate,
  type MembershipPolicy,
} from "../rhizome/types.ts";

/**
 * Where the member substrate comes from. The `load` form is the production seam:
 * point it at Cistern / the daemon / ATProto and this adapter is unchanged.
 */
export type MemberSubstrateSource =
  | { inline: MemberSubstrate }
  | { filePath: string }
  | { load: (subjectId: string) => MemberSubstrate | Promise<MemberSubstrate> };

/** Empty-but-valid substrate, used when a source fails so the run still completes. */
function emptySubstrate(memberId: string): MemberSubstrate {
  return { memberId, peerAttestations: [], contributionReceipts: [], participationLogs: [] };
}

/** Most recent ISO timestamp in a list, or undefined if the list is empty. */
function latestIso(times: string[]): string | undefined {
  let best: { iso: string; ms: number } | undefined;
  for (const iso of times) {
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) continue;
    if (!best || ms > best.ms) best = { iso, ms };
  }
  return best?.iso;
}

export class RhizomeMembershipAdapter implements EvidenceAdapter {
  readonly id = "rhizome-membership";
  #source: MemberSubstrateSource;

  constructor(source: MemberSubstrateSource) {
    this.#source = source;
  }

  async collect(query: EvidenceQuery): Promise<EvidenceBundle> {
    const collectedAt = new Date().toISOString();
    const failures: EvidenceBundle["failures"] = [];

    // ── Resolve substrate from the pluggable source. A failure is recorded, never
    //    thrown — the engine can still run and every claim becomes unresolved. ──
    let substrate: MemberSubstrate;
    try {
      substrate = await this.#resolve(query.subjectId);
    } catch (err) {
      return {
        subjectId: query.subjectId,
        collectedAt,
        adapterId: this.id,
        items: [],
        failures: [
          { source: this.#sourceLabel(), reason: err instanceof Error ? err.message : String(err) },
        ],
      };
    }

    const items: EvidenceItem[] = [];

    // ── Raw per-entry items (one EvidenceItem per substrate entry) ──────────────
    for (const a of substrate.peerAttestations) {
      items.push({
        id: randomUUID(),
        source: `peer:${a.voucher}`,
        kind: "peer-attestation",
        observedAt: a.observedAt,
        data: { voucher: a.voucher, subject: a.subject, statement: a.statement },
      });
    }
    for (const c of substrate.contributionReceipts) {
      items.push({
        id: randomUUID(),
        source: "contribution-ledger",
        kind: "contribution-receipt",
        observedAt: c.observedAt,
        data: { what: c.what, receipt_hash: c.receiptHash },
      });
    }
    for (const p of substrate.participationLogs) {
      items.push({
        id: randomUUID(),
        source: "participation-feed",
        kind: "participation-log",
        observedAt: p.observedAt,
        data: { activity: p.activity },
      });
    }

    // ── Derived rollups (bind the membership assertions to concrete fields) ─────
    const distinctVouchers = new Set(
      substrate.peerAttestations.map((a) => a.voucher.trim().toLowerCase()).filter(Boolean),
    );
    const attestationTimes = substrate.peerAttestations.map((a) => a.observedAt);
    items.push({
      id: randomUUID(),
      source: "rhizome:vouch-rollup",
      kind: "peer-attestation",
      observedAt: latestIso(attestationTimes) ?? collectedAt,
      data: { vouches: distinctVouchers.size, derived: true },
    });

    const contributionTimes = substrate.contributionReceipts.map((c) => c.observedAt);
    const lastContribution = latestIso(contributionTimes);
    items.push({
      id: randomUUID(),
      source: "rhizome:contribution-rollup",
      kind: "contribution-receipt",
      observedAt: lastContribution ?? collectedAt,
      data: {
        contribution_count: substrate.contributionReceipts.length,
        derived: true,
        // Only present when there is a contribution — absence keeps a freshness
        // claim honestly "unresolved" rather than silently passing or failing.
        ...(lastContribution ? { last_contribution: lastContribution } : {}),
      },
    });

    return { subjectId: query.subjectId, collectedAt, adapterId: this.id, items, failures };
  }

  async #resolve(subjectId: string): Promise<MemberSubstrate> {
    if ("inline" in this.#source) return this.#source.inline;
    if ("load" in this.#source) return this.#source.load(subjectId);
    // filePath form: a missing/corrupt file surfaces as a caught failure upstream.
    return JSON.parse(readFileSync(this.#source.filePath, "utf8")) as MemberSubstrate;
  }

  #sourceLabel(): string {
    if ("filePath" in this.#source) return this.#source.filePath;
    if ("load" in this.#source) return "rhizome:loader";
    return "rhizome:inline";
  }
}

// ── Standard membership claims ─────────────────────────────────────────────────

/** A member's own uncorroborated claim — the self-reported hygiene case. */
export type SelfReportedMetric = {
  id: string;
  /** The member's stated claim, e.g. "I onboarded 12 new members this quarter." */
  text: string;
  /**
   * Optional structured assertion. When it references a field no evidence item
   * carries, the rule-based strategy flags it (self-reported metric, no
   * corroboration) — exactly the co-op trust hygiene. Omit it and a metric-bearing
   * text still flags via the heuristic path.
   */
  assertion?: Assertion;
};

export type BuildMembershipClaimsOptions = {
  /** Membership thresholds. Defaults to DEFAULT_MEMBERSHIP_POLICY (≥3 vouches, ≤90d). */
  policy?: MembershipPolicy;
  /** The member's own self-reported claims — carried through with selfReported: true. */
  selfReported?: SelfReportedMetric[];
};

/**
 * Build the standard membership Claims for a member. These are the assertions
 * DESIGN.md names:
 *   - `atLeast field:"vouches" value:<minVouches>`   (peer-corroborated → not self-reported)
 *   - `freshWithinDays field:"last_contribution" days:<freshnessDays>`
 *   - any self-reported claims the member submits, flagged `selfReported: true`
 *     so an uncorroborated metric flags.
 *
 * The signed VerificationResult produced from these claims IS the member's
 * portable trust receipt.
 */
export function buildMembershipClaims(
  memberId: string,
  opts: BuildMembershipClaimsOptions = {},
): Claim[] {
  const policy = opts.policy ?? DEFAULT_MEMBERSHIP_POLICY;

  const claims: Claim[] = [
    {
      id: `${memberId}:vouches`,
      text: `At least ${policy.minVouches} peers vouch for this member.`,
      // Peer attestations are independent evidence, so this is not self-reported.
      selfReported: false,
      assertion: { kind: "atLeast", field: "vouches", value: policy.minVouches },
      attributes: { memberId, check: "membership-threshold" },
    },
    {
      id: `${memberId}:freshness`,
      text: `The member has a contribution within the last ${policy.freshnessDays} days.`,
      selfReported: false,
      assertion: { kind: "freshWithinDays", field: "last_contribution", days: policy.freshnessDays },
      attributes: { memberId, check: "activity-freshness" },
    },
  ];

  for (const sr of opts.selfReported ?? []) {
    claims.push({
      id: sr.id,
      text: sr.text,
      selfReported: true,
      ...(sr.assertion ? { assertion: sr.assertion } : {}),
      attributes: { memberId, check: "self-reported" },
    });
  }

  return claims;
}
