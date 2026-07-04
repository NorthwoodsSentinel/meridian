/**
 * Runnable Rhizome demo — the first real Meridian adapter, end to end.
 *
 *   bun run demo-rhizome/rhizome-demo.ts
 *
 * Flow (identical engine, zero engine changes vs. the enterprise-audit demo):
 *   RhizomeMembershipAdapter normalizes a member's substrate (peer vouches,
 *   contribution receipts, participation logs) → MeridianEngine challenges the
 *   standard membership claims with the RuleBasedChallengeStrategy → signs
 *   objections + the result with a local ed25519 key → we re-verify the
 *   signatures offline. The signed result IS the member's portable trust receipt.
 *
 * Two members run through the same pipeline:
 *   • aspen — enough vouches, fresh, self-report corroborated → PASSES, high score.
 *   • birch — one vouch, stale contribution, a self-reported metric with no
 *             corroboration → every claim FLAGGED, score floor.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Assertion, MemberSubstrate, VerificationResult } from "../src/index.ts";
import {
  Ed25519Signer,
  JsonFileReceiptStore,
  MeridianEngine,
  RhizomeMembershipAdapter,
  RuleBasedChallengeStrategy,
  buildMembershipClaims,
  runVerification,
  verifyResult,
  type SelfReportedMetric,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const signer = Ed25519Signer.loadOrCreate(join(here, "..", ".meridian-keys"));
const store = new JsonFileReceiptStore(join(here, "..", "demo-output"));
const engine = new MeridianEngine({
  strategy: new RuleBasedChallengeStrategy(),
  signer,
  store,
});

const bar = "═".repeat(72);
const glyph: Record<string, string> = { verified: "✓", flagged: "✗", unresolved: "?" };

async function runMember(file: string, selfReported: SelfReportedMetric[]): Promise<VerificationResult> {
  const substrate = JSON.parse(readFileSync(join(here, file), "utf8")) as MemberSubstrate;
  const adapter = new RhizomeMembershipAdapter({ inline: substrate });
  const claims = buildMembershipClaims(substrate.memberId, { selfReported });

  const result = await runVerification({
    subject: `Rhizome membership — ${substrate.memberId}`,
    claims,
    adapter,
    query: { subjectId: substrate.memberId },
    engine,
  });

  console.log(`\n${bar}`);
  console.log(`  PORTABLE TRUST RECEIPT — member "${substrate.memberId}"`);
  console.log(bar);
  console.log(`  runId       : ${result.runId}`);
  console.log(`  adapter     : ${result.adapterId}   strategy: ${result.strategyId}`);
  console.log(`  signer (pk) : ${result.signature.publicKey.slice(0, 32)}…`);
  console.log(bar);
  const status = result.flaggedCount === 0 && result.unresolvedCount === 0 ? "MEMBER IN GOOD STANDING" : "NEEDS REVIEW";
  console.log(
    `  verified: ${result.verifiedCount}   flagged: ${result.flaggedCount}   unresolved: ${result.unresolvedCount}   ` +
      `→  TRUST SCORE: ${result.confidenceScore}   [${status}]`,
  );
  console.log(bar);

  for (const o of result.outcomes) {
    console.log(`\n  [${glyph[o.verdict]}] ${o.verdict.toUpperCase()}  (${o.challengeType}, conf ${o.confidence})`);
    console.log(`      claim   : ${o.claimText}`);
    console.log(`      finding : ${o.challengeEvidence}`);
    if (o.objection) console.log(`      objection: ${o.objection}`);
  }

  console.log(`\n  signed objections (${result.signedObjections.length}) — detached ed25519 receipts:`);
  for (const obj of result.signedObjections) {
    console.log(`    • ${obj.claimId}  [${obj.challengeType}]  sig ${obj.signature.signature.slice(0, 24)}…`);
  }

  const check = verifyResult(result);
  console.log(`\n  re-verified offline — result: ${check.resultValid}   objections: ${check.objectionsValid}`);
  console.log(`  persisted receipt : demo-output/${result.runId}.json`);
  if (!check.resultValid || !check.objectionsValid) {
    console.error("SIGNATURE VERIFICATION FAILED");
    process.exit(1);
  }
  return result;
}

// aspen self-reports a metric that the evidence DOES corroborate (2 receipts on
// record) — so a self-reported claim can still verify when it is backed.
const aspenSelfReported: SelfReportedMetric[] = [
  {
    id: "aspen:self-contributions",
    text: "I have logged at least 2 contributions to the co-op.",
    assertion: { kind: "atLeast", field: "contribution_count", value: 2 } satisfies Assertion,
  },
];

// birch self-reports a big metric with NOTHING to corroborate it — the exact
// trust-hygiene case: a self-reported number with no evidence flags.
const birchSelfReported: SelfReportedMetric[] = [
  {
    id: "birch:self-payment-rails",
    text: "I personally contributed the entire payment-rails subsystem — 8000 lines.",
    assertion: { kind: "atLeast", field: "lines_contributed", value: 8000 } satisfies Assertion,
  },
];

const aspen = await runMember("member-passing.json", aspenSelfReported);
const birch = await runMember("member-flagged.json", birchSelfReported);

console.log(`\n${bar}`);
console.log(`  SUMMARY`);
console.log(bar);
console.log(`  aspen  → trust score ${aspen.confidenceScore}  (${aspen.flaggedCount} flagged)  — carries a clean receipt.`);
console.log(`  birch  → trust score ${birch.confidenceScore}  (${birch.flaggedCount} flagged)  — receipt shows the gaps.`);
console.log(`${bar}\n`);
