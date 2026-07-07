/**
 * cisternMemberLoader — the production `load` seam that points the
 * RhizomeMembershipAdapter at a LIVE Cistern instance.
 *
 * This is the wire between the two halves of the pipeline:
 *   Cistern (raw, provenance-stamped intake)  →  Meridian (adversarial trust)
 *
 * It never summarizes. It pages Cistern's read API for a source's episodes,
 * pulls each raw payload back byte-for-byte, and buckets them into the
 * `MemberSubstrate` shape the adapter already understands. All co-op-specific
 * knowledge stays in the adapter; this file only knows how to *read Cistern*.
 *
 * Cistern holds one episode per raw event. Each rhizome episode's raw payload is
 * a small JSON object carrying a `kind` discriminator and its `subject` (the
 * member it concerns):
 *   { kind: "vouch",        subject, voucher, statement?, observedAt? }
 *   { kind: "contribution", subject, what?, receiptHash,  observedAt? }
 *   { kind: "participation",subject, activity,             observedAt? }
 * `observedAt` falls back to the episode envelope's occurred_at, then ingested_at,
 * so the authoritative event time always comes from provenance, never invented.
 */
import type {
  MemberSubstrate,
  PeerAttestation,
  ContributionReceipt,
  ParticipationLog,
} from "../rhizome/types.ts";

export type CisternLoaderConfig = {
  /** Base URL of the Cistern worker, e.g. https://cistern.robert-chuvala.workers.dev */
  baseUrl: string;
  /** CISTERN_READ_TOKEN — the bearer token gating Cistern's read API. */
  token: string;
  /** Cistern source id holding the rhizome episodes. Default "rhizome". */
  source?: string;
  /** Page size for /episodes. Default 200. */
  pageLimit?: number;
  /** Injectable fetch (tests pass a mock; production uses global fetch). */
  fetchImpl?: typeof fetch;
};

type EpisodeEnvelope = {
  content_hash: string;
  occurred_at: string | null;
  ingested_at: string;
};

type EpisodesPage = { episodes: EpisodeEnvelope[]; nextCursor: string | null };

/** A non-empty string, or null. */
function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build a `load(subjectId)` function for the `{ load }` MemberSubstrateSource.
 * Point the RhizomeMembershipAdapter at the result and the pipeline is live.
 */
export function cisternMemberLoader(
  config: CisternLoaderConfig,
): (subjectId: string) => Promise<MemberSubstrate> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const source = config.source ?? "rhizome";
  const pageLimit = config.pageLimit ?? 200;
  const base = config.baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${config.token}` };

  async function listEnvelopes(): Promise<EpisodeEnvelope[]> {
    const all: EpisodeEnvelope[] = [];
    let since: string | null = null;
    // Hard page cap: a backstop against a misbehaving server, not a real limit.
    for (let page = 0; page < 1000; page++) {
      const q =
        `${base}/episodes?source=${encodeURIComponent(source)}&limit=${pageLimit}` +
        (since ? `&since=${encodeURIComponent(since)}` : "");
      const res = await fetchImpl(q, { headers });
      if (!res.ok) {
        throw new Error(`cistern GET /episodes ${res.status} for source=${source}`);
      }
      const body = (await res.json()) as EpisodesPage;
      all.push(...body.episodes);
      if (!body.nextCursor || body.episodes.length === 0) break;
      since = body.nextCursor;
    }
    return all;
  }

  async function fetchRaw(hash: string): Promise<unknown | null> {
    const res = await fetchImpl(`${base}/raw/${hash}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`cistern GET /raw ${res.status} for ${hash}`);
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null; // non-JSON raw isn't a rhizome membership event; skip it.
    }
  }

  return async function load(subjectId: string): Promise<MemberSubstrate> {
    const envelopes = await listEnvelopes();
    const peerAttestations: PeerAttestation[] = [];
    const contributionReceipts: ContributionReceipt[] = [];
    const participationLogs: ParticipationLog[] = [];

    for (const env of envelopes) {
      const raw = await fetchRaw(env.content_hash);
      if (raw === null || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;

      // Member-scope: the episode's payload names the member it concerns.
      if (asStr(r.subject) !== subjectId) continue;

      const observedAt = asStr(r.observedAt) ?? env.occurred_at ?? env.ingested_at;
      const kind = asStr(r.kind);

      if (kind === "vouch") {
        const voucher = asStr(r.voucher);
        if (voucher) {
          peerAttestations.push({
            voucher,
            subject: subjectId,
            statement: asStr(r.statement) ?? "",
            observedAt,
          });
        }
      } else if (kind === "contribution") {
        const receiptHash = asStr(r.receiptHash);
        if (receiptHash) {
          contributionReceipts.push({
            what: asStr(r.what) ?? "",
            receiptHash,
            observedAt,
          });
        }
      } else if (kind === "participation") {
        const activity = asStr(r.activity);
        if (activity) {
          participationLogs.push({ activity, observedAt });
        }
      }
    }

    return { memberId: subjectId, peerAttestations, contributionReceipts, participationLogs };
  };
}
