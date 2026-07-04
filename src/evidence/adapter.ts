/**
 * EvidenceAdapter — the pluggable evidence seam.
 *
 * kredence hardcoded its evidence sources (GitHub, website, onchain). Meridian
 * inverts that: the engine takes an abstract adapter, so the same core can later
 * be handed a Rhizome-member-substrate adapter or an enterprise-security-control
 * adapter without touching the adversarial logic. See DESIGN.md for both sketches.
 *
 * An adapter's only job: given a query, return a normalized EvidenceBundle.
 */
import type { EvidenceBundle } from "../types.ts";

export type EvidenceQuery = {
  /** Opaque id of the subject to collect evidence for. */
  subjectId: string;
  /** Adapter-specific parameters (a file path, a repo url, a member handle, ...). */
  params?: Record<string, unknown>;
};

export interface EvidenceAdapter {
  /** Stable identifier recorded on the bundle and result for provenance. */
  readonly id: string;
  collect(query: EvidenceQuery): Promise<EvidenceBundle>;
}
