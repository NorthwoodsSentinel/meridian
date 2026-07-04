import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeridianEngine, runVerification } from "../src/engine.ts";
import { RuleBasedChallengeStrategy } from "../src/challenge/ruleBased.ts";
import type { ChallengeStrategy } from "../src/challenge/strategy.ts";
import { Ed25519Signer } from "../src/signing.ts";
import { JsonFileReceiptStore } from "../src/store/jsonFileStore.ts";
import { LocalJsonEvidenceAdapter } from "../src/evidence/localJson.ts";
import { verifyResult } from "../src/verify.ts";
import type { Claim, EvidenceBundle } from "../src/types.ts";

function engine(extra?: { store?: JsonFileReceiptStore; strategy?: ChallengeStrategy }) {
  return new MeridianEngine({
    strategy: extra?.strategy ?? new RuleBasedChallengeStrategy(),
    signer: Ed25519Signer.generate(),
    ...(extra?.store ? { store: extra.store } : {}),
  });
}

const evidence: EvidenceBundle = {
  subjectId: "acme",
  collectedAt: new Date().toISOString(),
  adapterId: "test",
  items: [
    {
      id: "e1",
      source: "feed",
      kind: "activity-log",
      observedAt: new Date().toISOString(),
      data: { commits_90d: 42, contributor_count: 3, mfa_enabled: false, uptime_pct: 98.2 },
    },
  ],
  failures: [],
};

const claims: Claim[] = [
  { id: "c1", text: "20+ commits", selfReported: false, assertion: { kind: "atLeast", field: "commits_90d", value: 20 } },
  { id: "c2", text: "mfa enabled", selfReported: true, assertion: { kind: "equals", field: "mfa_enabled", value: true } },
  { id: "c3", text: "99.9% uptime", selfReported: true, assertion: { kind: "atLeast", field: "uptime_pct", value: 99.9 } },
  { id: "c4", text: "3 maintainers", selfReported: false, assertion: { kind: "equals", field: "contributor_count", value: 3 } },
  { id: "c5", text: "integrates with our IdP", selfReported: true },
];

describe("MeridianEngine.verify — full loop", () => {
  test("produces correct verdict tallies", async () => {
    const result = await engine().verify({ subject: "acme", claims, evidence });
    // c1 verified, c2 flagged, c3 flagged, c4 verified, c5 unresolved
    expect(result.verifiedCount).toBe(2);
    expect(result.flaggedCount).toBe(2);
    expect(result.unresolvedCount).toBe(1);
  });

  test("confidence score = (verified + 0.5*unresolved)/total", async () => {
    const result = await engine().verify({ subject: "acme", claims, evidence });
    // (2 + 0.5*1)/5 = 0.5
    expect(result.confidenceScore).toBe(0.5);
  });

  test("one signed objection per non-verified claim, and each verifies", async () => {
    const result = await engine().verify({ subject: "acme", claims, evidence });
    expect(result.signedObjections).toHaveLength(result.flaggedCount + result.unresolvedCount);
    const check = verifyResult(result);
    expect(check.objectionsValid).toBe(true);
    expect(check.objectionResults).toHaveLength(3);
  });

  test("verified claims produce no signed objection", async () => {
    const result = await engine().verify({ subject: "acme", claims, evidence });
    const objectedIds = new Set(result.signedObjections.map((o) => o.claimId));
    for (const o of result.outcomes) {
      if (o.verdict === "verified") expect(objectedIds.has(o.claimId)).toBe(false);
      else expect(objectedIds.has(o.claimId)).toBe(true);
    }
  });

  test("result signature verifies independently", async () => {
    const result = await engine().verify({ subject: "acme", claims, evidence });
    expect(verifyResult(result).resultValid).toBe(true);
  });

  test("tampering with a verdict invalidates the result signature", async () => {
    const result = await engine().verify({ subject: "acme", claims, evidence });
    const tampered = structuredClone(result);
    // flip a flagged verdict to verified to fake a better score
    const target = tampered.outcomes.find((o) => o.verdict === "flagged")!;
    target.verdict = "verified";
    expect(verifyResult(tampered).resultValid).toBe(false);
  });

  test("tampering with an objection invalidates that objection", async () => {
    const result = await engine().verify({ subject: "acme", claims, evidence });
    const tampered = structuredClone(result);
    tampered.signedObjections[0]!.objection = "nothing to see here";
    const check = verifyResult(tampered);
    expect(check.objectionsValid).toBe(false);
  });

  test("execution log covers collect → challenge → score → sign → persist", async () => {
    const result = await engine().verify({ subject: "acme", claims, evidence });
    const phases = new Set(result.executionLog.map((e) => e.phase));
    expect(phases.has("collect")).toBe(true);
    expect(phases.has("challenge")).toBe(true);
    expect(phases.has("score")).toBe(true);
    expect(phases.has("sign")).toBe(true);
    expect(phases.has("persist")).toBe(true);
  });

  test("a throwing strategy yields unresolved, not a crash", async () => {
    const boom: ChallengeStrategy = {
      id: "boom",
      challenge() {
        throw new Error("kaboom");
      },
    };
    const result = await engine({ strategy: boom }).verify({ subject: "acme", claims, evidence });
    expect(result.verifiedCount).toBe(0);
    expect(result.unresolvedCount).toBe(claims.length);
    expect(result.outcomes.every((o) => o.challengeEvidence.includes("kaboom"))).toBe(true);
  });

  test("empty claim set → score 0, valid signature, no objections", async () => {
    const result = await engine().verify({ subject: "acme", claims: [], evidence });
    expect(result.confidenceScore).toBe(0);
    expect(result.signedObjections).toHaveLength(0);
    expect(verifyResult(result).resultValid).toBe(true);
  });
});

describe("persistence + runVerification", () => {
  test("saves the result and reloads an identical record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-receipts-"));
    const store = new JsonFileReceiptStore(dir);
    const result = await engine({ store }).verify({ subject: "acme", claims, evidence });
    const loaded = await store.load(result.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(result.runId);
    expect(loaded!.confidenceScore).toBe(result.confidenceScore);
    expect(verifyResult(loaded!).resultValid).toBe(true);
  });

  test("runVerification collects via adapter then verifies", async () => {
    const adapter = new LocalJsonEvidenceAdapter({
      inline: [{ kind: "activity-log", data: { commits_90d: 42 } }],
    });
    const result = await runVerification({
      subject: "acme",
      claims: [claims[0]!],
      adapter,
      query: { subjectId: "acme" },
      engine: engine(),
    });
    expect(result.adapterId).toBe("local-json");
    expect(result.verifiedCount).toBe(1);
  });
});
