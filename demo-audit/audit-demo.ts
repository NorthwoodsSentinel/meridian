/**
 * Runnable enterprise-audit demo — the paid security-audit twin of the Rhizome
 * membership demo, end to end.
 *
 *   bun run demo-audit/audit-demo.ts   (or: bun run demo:audit)
 *
 * Flow (identical engine, zero engine changes vs. the co-op-trust demo):
 *   EvidenceAuditAdapter normalizes a client's observed control state (MFA config,
 *   encryption scan, log retention, vuln counts, scan/backup freshness) →
 *   MeridianEngine challenges the audit claims with the RuleBasedChallengeStrategy →
 *   signs objections + the result with a local ed25519 key → we re-verify the
 *   signatures offline. The signed result IS the client's portable AUDIT RECEIPT:
 *   verified controls, flagged gaps each with a signed objection citing the real
 *   observed value, and a confidence score for the control set.
 *
 * The sample control set is deliberately mixed so the receipt shows both faces:
 *   • IA-2, AU-11, VM-2  → observed state satisfies the claim  → VERIFIED.
 *   • SC-28 (at-rest encryption off), RA-5 (3 criticals), CP-9 (stale backup test),
 *     AC-2 (self-reported 100% coverage, no scan) → FLAGGED, each with a signed
 *     objection a CISO/board/regulator can re-check offline.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ControlSet } from "../src/index.ts";
import {
  Ed25519Signer,
  EvidenceAuditAdapter,
  JsonFileReceiptStore,
  MeridianEngine,
  RuleBasedChallengeStrategy,
  buildAuditClaims,
  runVerification,
  verifyResult,
} from "../src/index.ts";

/** ISO timestamp `n` days before now — keeps freshness outcomes clock-independent. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

const here = dirname(fileURLToPath(import.meta.url));
const controlSet = JSON.parse(readFileSync(join(here, "control-set.json"), "utf8")) as ControlSet;

// Patch the freshness-sensitive observations to real relative times so the demo's
// verdicts are deterministic no matter when it runs: VM-2 fresh (5d ago → passes a
// 30d window), CP-9 stale (200d ago → fails a 90d window).
const observedAtByControl: Record<string, string> = {
  "VM-2": daysAgo(5),
  "CP-9": daysAgo(200),
};
for (const control of controlSet.controls) {
  const patched = observedAtByControl[control.id];
  if (patched !== undefined && control.observation !== undefined) {
    control.observation.observedAt = patched;
  }
}

const signer = Ed25519Signer.loadOrCreate(join(here, "..", ".meridian-keys"));
const store = new JsonFileReceiptStore(join(here, "..", "demo-output"));
const engine = new MeridianEngine({
  strategy: new RuleBasedChallengeStrategy(),
  signer,
  store,
});

const result = await runVerification({
  subject: controlSet.label ?? controlSet.systemId,
  claims: buildAuditClaims(controlSet),
  adapter: new EvidenceAuditAdapter({ inline: controlSet }),
  query: { subjectId: controlSet.systemId },
  engine,
});

const bar = "═".repeat(72);
const glyph: Record<string, string> = { verified: "✓", flagged: "✗", unresolved: "?" };

console.log(`\n${bar}`);
console.log(`  PORTABLE AUDIT RECEIPT — system "${controlSet.systemId}"`);
console.log(bar);
console.log(`  subject     : ${result.subject}`);
console.log(`  runId       : ${result.runId}`);
console.log(`  adapter     : ${result.adapterId}   strategy: ${result.strategyId}`);
console.log(`  signer (pk) : ${result.signature.publicKey.slice(0, 32)}…`);
console.log(bar);
const status = result.flaggedCount === 0 && result.unresolvedCount === 0 ? "PASSED AUDIT" : "GAPS FOUND";
console.log(
  `  verified: ${result.verifiedCount}   flagged: ${result.flaggedCount}   unresolved: ${result.unresolvedCount}   ` +
    `→  CONTROL-SET SCORE: ${result.confidenceScore}   [${status}]`,
);
console.log(bar);

for (const o of result.outcomes) {
  console.log(`\n  [${glyph[o.verdict]}] ${o.verdict.toUpperCase()}  (${o.challengeType}, conf ${o.confidence})`);
  console.log(`      control  : ${o.claimText}`);
  console.log(`      finding  : ${o.challengeEvidence}`);
  if (o.objection) console.log(`      objection: ${o.objection}`);
}

console.log(`\n  signed objections (${result.signedObjections.length}) — detached ed25519 receipts:`);
for (const obj of result.signedObjections) {
  console.log(`    • ${obj.claimId}  [${obj.challengeType}]  sig ${obj.signature.signature.slice(0, 24)}…`);
}

const check = verifyResult(result);
console.log(`\n${bar}`);
console.log(`  INDEPENDENT RE-VERIFICATION (anyone, offline — no engine, no network)`);
console.log(bar);
console.log(`  result signature valid : ${check.resultValid}`);
console.log(`  all objections valid   : ${check.objectionsValid}`);
console.log(`  execution-log entries  : ${result.executionLog.length}`);
console.log(`  persisted receipt      : demo-output/${result.runId}.json`);
console.log(`${bar}\n`);

if (!check.resultValid || !check.objectionsValid) {
  console.error("SIGNATURE VERIFICATION FAILED");
  process.exit(1);
}
