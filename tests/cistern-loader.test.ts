import { test, expect } from "bun:test";
import { cisternMemberLoader } from "../src/evidence/cistern.ts";
import {
  RhizomeMembershipAdapter,
  MeridianEngine,
  RuleBasedChallengeStrategy,
  Ed25519Signer,
  buildMembershipClaims,
  runVerification,
  verifyResult,
} from "../src/index.ts";

/** 64-hex content-hash from an index (the loader treats it opaquely). */
function h(i: number): string {
  return i.toString(16).padStart(64, "0");
}

type Ep = { hash: string; raw: unknown; occurred_at?: string };

/** A stand-in Cistern read API backed by an in-memory episode set. */
function mockCistern(episodes: Ep[]): typeof fetch {
  const rawByHash = new Map(episodes.map((e) => [e.hash, e.raw]));
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/episodes") {
      const body = {
        episodes: episodes.map((e) => ({
          content_hash: e.hash,
          occurred_at: e.occurred_at ?? null,
          ingested_at: "2026-07-06T00:00:00.000Z",
        })),
        nextCursor: null,
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.pathname.startsWith("/raw/")) {
      const hash = url.pathname.slice("/raw/".length);
      if (!rawByHash.has(hash)) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(rawByHash.get(hash)), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const NOW = new Date().toISOString();

test("loader buckets a member's episodes and filters out other members", async () => {
  const eps: Ep[] = [
    { hash: h(1), raw: { kind: "vouch", subject: "aspen", voucher: "beech", statement: "solid", observedAt: NOW } },
    { hash: h(2), raw: { kind: "vouch", subject: "aspen", voucher: "cedar", statement: "reliable", observedAt: NOW } },
    { hash: h(3), raw: { kind: "vouch", subject: "aspen", voucher: "dogwood", statement: "shows up", observedAt: NOW } },
    { hash: h(4), raw: { kind: "vouch", subject: "aspen", voucher: "elm", statement: "trusted", observedAt: NOW } },
    { hash: h(5), raw: { kind: "contribution", subject: "aspen", what: "wrote the intake docs", receiptHash: "rc-1", observedAt: NOW } },
    { hash: h(6), raw: { kind: "participation", subject: "aspen", activity: "governance vote", observedAt: NOW } },
    // belongs to another member — must be filtered out:
    { hash: h(7), raw: { kind: "vouch", subject: "someone-else", voucher: "fir", statement: "x", observedAt: NOW } },
    // malformed — must be skipped, not throw:
    { hash: h(8), raw: { kind: "vouch", subject: "aspen" /* no voucher */, observedAt: NOW } },
  ];
  const load = cisternMemberLoader({ baseUrl: "https://cistern.test/", token: "t", fetchImpl: mockCistern(eps) });
  const substrate = await load("aspen");

  expect(substrate.memberId).toBe("aspen");
  expect(substrate.peerAttestations.length).toBe(4);
  expect(substrate.contributionReceipts.length).toBe(1);
  expect(substrate.participationLogs.length).toBe(1);
  expect(substrate.peerAttestations.map((a) => a.voucher).sort()).toEqual(["beech", "cedar", "dogwood", "elm"]);
});

test("full wire: live-shaped Cistern data → adapter → engine → signed clean receipt", async () => {
  const eps: Ep[] = [
    { hash: h(1), raw: { kind: "vouch", subject: "aspen", voucher: "beech", observedAt: NOW } },
    { hash: h(2), raw: { kind: "vouch", subject: "aspen", voucher: "cedar", observedAt: NOW } },
    { hash: h(3), raw: { kind: "vouch", subject: "aspen", voucher: "dogwood", observedAt: NOW } },
    { hash: h(4), raw: { kind: "contribution", subject: "aspen", what: "docs", receiptHash: "rc-1", observedAt: NOW } },
  ];
  const load = cisternMemberLoader({ baseUrl: "https://cistern.test", token: "t", fetchImpl: mockCistern(eps) });
  const engine = new MeridianEngine({ strategy: new RuleBasedChallengeStrategy(), signer: Ed25519Signer.generate() });
  const adapter = new RhizomeMembershipAdapter({ load });
  const result = await runVerification({
    subject: "Rhizome membership — aspen (via live Cistern loader)",
    claims: buildMembershipClaims("aspen"),
    adapter,
    query: { subjectId: "aspen" },
    engine,
  });

  expect(result.confidenceScore).toBe(1);
  expect(result.flaggedCount).toBe(0);
  expect(verifyResult(result).resultValid).toBe(true);
});

test("full wire: gaming member (1 vouch, stale contribution) → flagged", async () => {
  const eps: Ep[] = [
    { hash: h(1), raw: { kind: "vouch", subject: "birch", voucher: "beech", observedAt: NOW } },
    { hash: h(2), raw: { kind: "contribution", subject: "birch", what: "old work", receiptHash: "rc-old", observedAt: "2026-01-01T00:00:00.000Z" } },
  ];
  const load = cisternMemberLoader({ baseUrl: "https://cistern.test", token: "t", fetchImpl: mockCistern(eps) });
  const engine = new MeridianEngine({ strategy: new RuleBasedChallengeStrategy(), signer: Ed25519Signer.generate() });
  const adapter = new RhizomeMembershipAdapter({ load });
  const result = await runVerification({
    subject: "Rhizome membership — birch",
    claims: buildMembershipClaims("birch"),
    adapter,
    query: { subjectId: "birch" },
    engine,
  });

  expect(result.flaggedCount).toBeGreaterThanOrEqual(1);
  expect(result.confidenceScore).toBeLessThan(1);
  expect(verifyResult(result).resultValid).toBe(true);
});

test("loader surfaces a Cistern auth failure as an adapter failure, not a crash", async () => {
  const failing = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  const load = cisternMemberLoader({ baseUrl: "https://cistern.test", token: "bad", fetchImpl: failing });
  const adapter = new RhizomeMembershipAdapter({ load });
  const bundle = await adapter.collect({ subjectId: "aspen" });
  expect(bundle.items.length).toBe(0);
  expect(bundle.failures.length).toBe(1);
});
