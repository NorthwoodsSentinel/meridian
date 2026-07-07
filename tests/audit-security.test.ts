// Adversarial regression suite for the T-095 verifier fixes (cross-lineage findings
// from Anvil/T-094). Each test asserts the SECURE behavior for an attack that
// previously succeeded — false-verify via shared field, future-dated freshness,
// receipt-field tampering, malformed-category abort, ReDoS, and no-evidence scoring.
import { describe, expect, test } from "bun:test";
import {
  EvidenceAuditAdapter,
  buildAuditClaims,
  MeridianEngine,
  RuleBasedChallengeStrategy,
  Ed25519Signer,
  runVerification,
  verifyResult,
} from "../src/index.ts";
import type { ControlSet } from "../src/index.ts";

function engine(unresolvedWeight?: number) {
  return new MeridianEngine({
    strategy: new RuleBasedChallengeStrategy(),
    signer: Ed25519Signer.generate(),
    ...(unresolvedWeight !== undefined ? { unresolvedWeight } : {}),
  });
}
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
const daysFromNow = (n: number) => new Date(Date.now() + n * 864e5).toISOString();

test("F1 CLOSED — failing control sharing a field is FLAGGED, not verified", async () => {
  const set: ControlSet = {
    systemId: "acme-prod", label: "Acme",
    controls: [
      { id: "SC-28-app", name: "Encryption (app).", category: "encryption", field: "encryption_at_rest_enabled", claimed: { kind: "equals", value: true }, observation: { value: true, observedAt: daysAgo(1) } },
      { id: "SC-28-db", name: "Encryption (db).", category: "encryption", field: "encryption_at_rest_enabled", claimed: { kind: "equals", value: true }, observation: { value: false, observedAt: daysAgo(1) } },
    ],
  };
  const result = await runVerification({ subject: "Acme", claims: buildAuditClaims(set), adapter: new EvidenceAuditAdapter({ inline: set }), query: { subjectId: set.systemId }, engine: engine() });
  const db = result.outcomes.find((o) => o.claimId === "SC-28-db")!;
  console.log("  F1: SC-28-db verdict =", db.verdict, "| flaggedCount =", result.flaggedCount, "| score =", result.confidenceScore);
  expect(db.verdict).toBe("flagged");
  expect(result.flaggedCount).toBeGreaterThanOrEqual(1);
  expect(result.confidenceScore).toBeLessThan(1);
  expect(verifyResult(result).resultValid).toBe(true); // receipt honestly signs the flag
});

test("F2 CLOSED — future-dated observation is FLAGGED, not fresh", async () => {
  const set: ControlSet = { systemId: "acme", controls: [
    { id: "CP-9", name: "Backup within 90d.", category: "resilience", field: "last_backup_test", claimed: { kind: "freshWithinDays", days: 90 }, observation: { value: "drill", observedAt: daysFromNow(365) } },
  ] };
  const result = await runVerification({ subject: "acme", claims: buildAuditClaims(set), adapter: new EvidenceAuditAdapter({ inline: set }), query: { subjectId: set.systemId }, engine: engine() });
  const cp9 = result.outcomes.find((o) => o.claimId === "CP-9")!;
  console.log("  F2: CP-9 future-dated verdict =", cp9.verdict);
  expect(cp9.verdict).toBe("flagged");
});

test("F3 CLOSED — tampering objection confidence/evidence or claimText breaks the signature", async () => {
  const set: ControlSet = { systemId: "acme", controls: [
    { id: "SC-28", name: "Encryption.", category: "encryption", field: "encryption_at_rest_enabled", claimed: { kind: "equals", value: true }, observation: { value: false, observedAt: daysAgo(1) } },
  ] };
  const result = await runVerification({ subject: "acme", claims: buildAuditClaims(set), adapter: new EvidenceAuditAdapter({ inline: set }), query: { subjectId: set.systemId }, engine: engine() });
  expect(verifyResult(result).objectionsValid).toBe(true); // valid before tamper

  result.signedObjections[0]!.confidence = 0.01;
  result.signedObjections[0]!.challengeEvidence = "Everything looks fine.";
  const afterObjTamper = verifyResult(result);
  console.log("  F3: objectionsValid after tampering confidence/evidence =", afterObjTamper.objectionsValid);
  expect(afterObjTamper.objectionsValid).toBe(false);

  // fresh run to isolate the claimText-digest binding
  const r2 = await runVerification({ subject: "acme", claims: buildAuditClaims(set), adapter: new EvidenceAuditAdapter({ inline: set }), query: { subjectId: set.systemId }, engine: engine() });
  expect(verifyResult(r2).resultValid).toBe(true);
  r2.outcomes[0]!.claimText = "Completely different claim.";
  const afterTextTamper = verifyResult(r2);
  console.log("  F3: resultValid after tampering claimText =", afterTextTamper.resultValid);
  expect(afterTextTamper.resultValid).toBe(false);
});

test("F4 CLOSED — unknown category records a failure, does NOT throw / abort", async () => {
  const set = { systemId: "acme", controls: [
    { id: "X-1", name: "pq control", category: "quantum-resistance", field: "pq_enabled", claimed: { kind: "equals", value: true }, observation: { value: true, observedAt: daysAgo(1) } },
  ] } as unknown as ControlSet;
  let threw = false;
  const bundle = await new EvidenceAuditAdapter({ inline: set }).collect({ subjectId: "acme" }).catch((e) => { threw = true; throw e; });
  console.log("  F4: collect threw =", threw, "| failures =", bundle.failures.length, "| items =", bundle.items.length);
  expect(threw).toBe(false);
  expect(bundle.failures.length).toBeGreaterThanOrEqual(1);
  expect(bundle.items.length).toBe(0); // bad control emitted no evidence
});

test("F5 CLOSED — oversized regex pattern is UNRESOLVED, not a hang", async () => {
  const set: ControlSet = { systemId: "acme", controls: [
    { id: "RG-1", name: "matches something", category: "logging", field: "log_line", claimed: { kind: "matches", pattern: "a".repeat(250) }, observation: { value: "aaa", observedAt: daysAgo(1) } },
  ] };
  const result = await runVerification({ subject: "acme", claims: buildAuditClaims(set), adapter: new EvidenceAuditAdapter({ inline: set }), query: { subjectId: set.systemId }, engine: engine() });
  const rg = result.outcomes.find((o) => o.claimId === "RG-1")!;
  console.log("  F5: oversized-pattern verdict =", rg.verdict);
  expect(rg.verdict).toBe("unresolved");
});

test("F6 CLOSED — audit engine (unresolvedWeight 0) gives no credit for an unobserved control", async () => {
  const set: ControlSet = { systemId: "acme", controls: [
    { id: "U-1", name: "Access reviews done.", category: "access", field: "access_review_coverage", claimed: { kind: "equals", value: true } },
  ] };
  const strict = await runVerification({ subject: "acme", claims: buildAuditClaims(set), adapter: new EvidenceAuditAdapter({ inline: set }), query: { subjectId: set.systemId }, engine: engine(0) });
  const parity = await runVerification({ subject: "acme", claims: buildAuditClaims(set), adapter: new EvidenceAuditAdapter({ inline: set }), query: { subjectId: set.systemId }, engine: engine() });
  console.log("  F6: unobserved score — audit(weight0) =", strict.confidenceScore, "| co-op default =", parity.confidenceScore);
  expect(strict.confidenceScore).toBe(0);
  expect(parity.confidenceScore).toBe(0.5); // co-op parity unchanged
});
