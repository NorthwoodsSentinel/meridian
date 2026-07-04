import { describe, expect, test } from "bun:test";
import {
  RhizomeMembershipAdapter,
  buildMembershipClaims,
  MeridianEngine,
  RuleBasedChallengeStrategy,
  Ed25519Signer,
  runVerification,
  verifyResult,
  DEFAULT_MEMBERSHIP_POLICY,
} from "../src/index.ts";
import type { MemberSubstrate, SelfReportedMetric } from "../src/index.ts";

/** ISO timestamp `n` days before now — keeps freshness tests independent of the clock. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function engine() {
  return new MeridianEngine({
    strategy: new RuleBasedChallengeStrategy(),
    signer: Ed25519Signer.generate(),
  });
}

/** A member in good standing: 3 distinct vouchers, a fresh contribution. */
function wellVouchedSubstrate(): MemberSubstrate {
  return {
    memberId: "aspen",
    peerAttestations: [
      { voucher: "cedar", subject: "aspen", statement: "reliable", observedAt: daysAgo(10) },
      { voucher: "willow", subject: "aspen", statement: "ships work", observedAt: daysAgo(20) },
      { voucher: "sorrel", subject: "aspen", statement: "carried the rota", observedAt: daysAgo(5) },
    ],
    contributionReceipts: [
      { what: "wrote the spec", receiptHash: "sha256:aaa", observedAt: daysAgo(9) },
      { what: "ran onboarding", receiptHash: "sha256:bbb", observedAt: daysAgo(40) },
    ],
    participationLogs: [{ activity: "governance call", observedAt: daysAgo(3) }],
  };
}

describe("RhizomeMembershipAdapter — normalization", () => {
  test("maps each substrate entry to an EvidenceItem of the right kind", async () => {
    const sub = wellVouchedSubstrate();
    const bundle = await new RhizomeMembershipAdapter({ inline: sub }).collect({ subjectId: "aspen" });

    expect(bundle.adapterId).toBe("rhizome-membership");
    expect(bundle.subjectId).toBe("aspen");

    const attest = bundle.items.filter((i) => i.kind === "peer-attestation");
    const contrib = bundle.items.filter((i) => i.kind === "contribution-receipt");
    const part = bundle.items.filter((i) => i.kind === "participation-log");

    // 3 raw peer-attestations + 1 vouch rollup; 2 raw receipts + 1 contribution rollup.
    expect(attest).toHaveLength(4);
    expect(contrib).toHaveLength(3);
    expect(part).toHaveLength(1);

    // Raw items carry the source data and their own observedAt.
    const rawAttest = attest.find((i) => i.source === "peer:cedar")!;
    expect(rawAttest.data.voucher).toBe("cedar");
    expect(rawAttest.data.statement).toBe("reliable");
    expect(rawAttest.observedAt).toBe(sub.peerAttestations[0]!.observedAt);
  });

  test("vouch rollup counts DISTINCT vouchers (a peer vouching twice is one vouch)", async () => {
    const sub: MemberSubstrate = {
      memberId: "birch",
      peerAttestations: [
        { voucher: "cedar", subject: "birch", statement: "a", observedAt: daysAgo(2) },
        { voucher: "cedar", subject: "birch", statement: "b again", observedAt: daysAgo(1) },
      ],
      contributionReceipts: [],
      participationLogs: [],
    };
    const bundle = await new RhizomeMembershipAdapter({ inline: sub }).collect({ subjectId: "birch" });
    const rollup = bundle.items.find((i) => i.source === "rhizome:vouch-rollup")!;
    expect(rollup.data.vouches).toBe(1);
    expect(rollup.data.derived).toBe(true);
  });

  test("contribution rollup exposes last_contribution + count with the latest observedAt", async () => {
    const bundle = await new RhizomeMembershipAdapter({ inline: wellVouchedSubstrate() }).collect({
      subjectId: "aspen",
    });
    const rollup = bundle.items.find((i) => i.source === "rhizome:contribution-rollup")!;
    expect(rollup.data.contribution_count).toBe(2);
    // Latest of daysAgo(9) and daysAgo(40) is daysAgo(9).
    expect(rollup.data.last_contribution).toBe(rollup.observedAt);
  });

  test("no contributions → rollup omits last_contribution (honest absence, not a fake pass)", async () => {
    const sub: MemberSubstrate = {
      memberId: "moss",
      peerAttestations: [],
      contributionReceipts: [],
      participationLogs: [],
    };
    const bundle = await new RhizomeMembershipAdapter({ inline: sub }).collect({ subjectId: "moss" });
    const rollup = bundle.items.find((i) => i.source === "rhizome:contribution-rollup")!;
    expect(rollup.data.contribution_count).toBe(0);
    expect("last_contribution" in rollup.data).toBe(false);
    // vouch rollup still present with 0 so an "atLeast vouches" claim flags, not stalls.
    const vouch = bundle.items.find((i) => i.source === "rhizome:vouch-rollup")!;
    expect(vouch.data.vouches).toBe(0);
  });

  test("pluggable load() source is honored (the Cistern / daemon / ATProto seam)", async () => {
    let askedFor = "";
    const adapter = new RhizomeMembershipAdapter({
      load: async (subjectId) => {
        askedFor = subjectId;
        return wellVouchedSubstrate();
      },
    });
    const bundle = await adapter.collect({ subjectId: "aspen" });
    expect(askedFor).toBe("aspen");
    expect(bundle.items.length).toBeGreaterThan(0);
  });

  test("a failing source is a recorded failure, not a thrown crash", async () => {
    const adapter = new RhizomeMembershipAdapter({
      load: () => {
        throw new Error("cistern unreachable");
      },
    });
    const bundle = await adapter.collect({ subjectId: "aspen" });
    expect(bundle.items).toHaveLength(0);
    expect(bundle.failures).toHaveLength(1);
    expect(bundle.failures[0]!.reason).toContain("cistern unreachable");
  });
});

describe("buildMembershipClaims", () => {
  test("builds the two standard claims from DESIGN with the default policy", () => {
    const claims = buildMembershipClaims("aspen");
    const vouch = claims.find((c) => c.id === "aspen:vouches")!;
    const fresh = claims.find((c) => c.id === "aspen:freshness")!;
    expect(vouch.assertion).toEqual({ kind: "atLeast", field: "vouches", value: 3 });
    expect(fresh.assertion).toEqual({ kind: "freshWithinDays", field: "last_contribution", days: 90 });
    // Peer-corroborated claims are not self-reported.
    expect(vouch.selfReported).toBe(false);
    expect(fresh.selfReported).toBe(false);
    expect(DEFAULT_MEMBERSHIP_POLICY.minVouches).toBe(3);
  });

  test("self-reported metrics are carried through with selfReported: true", () => {
    const sr: SelfReportedMetric[] = [{ id: "x", text: "I did 12 things" }];
    const claims = buildMembershipClaims("aspen", { selfReported: sr });
    const self = claims.find((c) => c.id === "x")!;
    expect(self.selfReported).toBe(true);
  });

  test("policy overrides flow into the assertions", () => {
    const claims = buildMembershipClaims("aspen", { policy: { minVouches: 5, freshnessDays: 30 } });
    expect(claims.find((c) => c.id === "aspen:vouches")!.assertion).toEqual({
      kind: "atLeast",
      field: "vouches",
      value: 5,
    });
    expect(claims.find((c) => c.id === "aspen:freshness")!.assertion).toEqual({
      kind: "freshWithinDays",
      field: "last_contribution",
      days: 30,
    });
  });
});

describe("end-to-end membership verification", () => {
  test("a well-vouched, fresh, corroborated member scores high and re-verifies offline", async () => {
    const sub = wellVouchedSubstrate();
    const result = await runVerification({
      subject: "aspen",
      claims: buildMembershipClaims(sub.memberId, {
        selfReported: [
          {
            id: "aspen:self",
            text: "I have logged at least 2 contributions.",
            assertion: { kind: "atLeast", field: "contribution_count", value: 2 },
          },
        ],
      }),
      adapter: new RhizomeMembershipAdapter({ inline: sub }),
      query: { subjectId: sub.memberId },
      engine: engine(),
    });

    expect(result.verifiedCount).toBe(3);
    expect(result.flaggedCount).toBe(0);
    expect(result.confidenceScore).toBe(1);

    // The signed result IS the portable trust receipt — anyone can re-check it.
    const check = verifyResult(result);
    expect(check.resultValid).toBe(true);
    expect(check.objectionsValid).toBe(true);
  });

  test("an uncorroborated self-reported metric flags", async () => {
    const sub = wellVouchedSubstrate();
    const result = await runVerification({
      subject: "aspen",
      claims: buildMembershipClaims(sub.memberId, {
        selfReported: [
          {
            id: "aspen:overclaim",
            text: "I personally wrote 8000 lines of the payment-rails subsystem.",
            assertion: { kind: "atLeast", field: "lines_contributed", value: 8000 },
          },
        ],
      }),
      adapter: new RhizomeMembershipAdapter({ inline: sub }),
      query: { subjectId: sub.memberId },
      engine: engine(),
    });

    const flagged = result.outcomes.find((o) => o.claimId === "aspen:overclaim")!;
    expect(flagged.verdict).toBe("flagged");
    expect(flagged.challengeType).toBe("unsupported");
    expect(flagged.objection).toBeString();
    // And it carries a signed objection receipt.
    expect(result.signedObjections.some((o) => o.claimId === "aspen:overclaim")).toBe(true);
  });

  test("too few vouches flags the membership-threshold claim", async () => {
    const sub: MemberSubstrate = {
      memberId: "birch",
      peerAttestations: [{ voucher: "cedar", subject: "birch", statement: "met once", observedAt: daysAgo(30) }],
      contributionReceipts: [{ what: "typo fix", receiptHash: "sha256:z", observedAt: daysAgo(5) }],
      participationLogs: [],
    };
    const result = await runVerification({
      subject: "birch",
      claims: buildMembershipClaims(sub.memberId),
      adapter: new RhizomeMembershipAdapter({ inline: sub }),
      query: { subjectId: sub.memberId },
      engine: engine(),
    });
    const vouch = result.outcomes.find((o) => o.claimId === "birch:vouches")!;
    expect(vouch.verdict).toBe("flagged");
    expect(vouch.challengeType).toBe("overclaim");
  });

  test("a stale last_contribution flags via freshWithinDays", async () => {
    const sub: MemberSubstrate = {
      memberId: "birch",
      peerAttestations: [
        { voucher: "cedar", subject: "birch", statement: "a", observedAt: daysAgo(10) },
        { voucher: "willow", subject: "birch", statement: "b", observedAt: daysAgo(11) },
        { voucher: "sorrel", subject: "birch", statement: "c", observedAt: daysAgo(12) },
      ],
      contributionReceipts: [{ what: "old work", receiptHash: "sha256:old", observedAt: daysAgo(175) }],
      participationLogs: [],
    };
    const result = await runVerification({
      subject: "birch",
      claims: buildMembershipClaims(sub.memberId),
      adapter: new RhizomeMembershipAdapter({ inline: sub }),
      query: { subjectId: sub.memberId },
      engine: engine(),
    });
    const fresh = result.outcomes.find((o) => o.claimId === "birch:freshness")!;
    expect(fresh.verdict).toBe("flagged");
    expect(fresh.challengeType).toBe("stale");
    // Vouches still verified — the receipt is honest per-claim, not all-or-nothing.
    expect(result.outcomes.find((o) => o.claimId === "birch:vouches")!.verdict).toBe("verified");
  });
});
