/**
 * Runnable demo — executes the full Meridian loop on sample claims + evidence and
 * prints the confidence-scored, signed result. Fully offline.
 *
 *   bun run demo/demo.ts
 *
 * Flow: LocalJsonEvidenceAdapter collects the bundle → MeridianEngine challenges
 * every claim with the RuleBasedChallengeStrategy → signs objections + result with
 * a local ed25519 key → JsonFileReceiptStore persists it → we re-verify the
 * signatures independently to prove the receipt is authentic.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Claim } from "../src/index.ts";
import {
  Ed25519Signer,
  JsonFileReceiptStore,
  LocalJsonEvidenceAdapter,
  MeridianEngine,
  RuleBasedChallengeStrategy,
  runVerification,
  verifyResult,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const claims = JSON.parse(readFileSync(join(here, "sample-claims.json"), "utf8")) as Claim[];

const adapter = new LocalJsonEvidenceAdapter({ filePath: join(here, "sample-evidence.json") });
const signer = Ed25519Signer.loadOrCreate(join(here, "..", ".meridian-keys"));
const store = new JsonFileReceiptStore(join(here, "..", "demo-output"));

const engine = new MeridianEngine({
  strategy: new RuleBasedChallengeStrategy(),
  signer,
  store,
});

const result = await runVerification({
  subject: "Acme Widget — reporting-period attestation",
  claims,
  adapter,
  query: { subjectId: "acme-widget" },
  engine,
});

const bar = "═".repeat(72);
console.log(`\n${bar}`);
console.log(`  MERIDIAN VERIFICATION RESULT`);
console.log(bar);
console.log(`  subject      : ${result.subject}`);
console.log(`  runId        : ${result.runId}`);
console.log(`  adapter      : ${result.adapterId}   strategy: ${result.strategyId}`);
console.log(`  signer (pk)  : ${result.signature.publicKey.slice(0, 32)}…`);
console.log(bar);
console.log(
  `  verified: ${result.verifiedCount}   flagged: ${result.flaggedCount}   unresolved: ${result.unresolvedCount}   ` +
    `→  CONFIDENCE SCORE: ${result.confidenceScore}`,
);
console.log(bar);

const glyph: Record<string, string> = { verified: "✓", flagged: "✗", unresolved: "?" };
for (const o of result.outcomes) {
  console.log(
    `\n  [${glyph[o.verdict]}] ${o.verdict.toUpperCase()}  (${o.challengeType}, conf ${o.confidence})`,
  );
  console.log(`      claim   : ${o.claimText}`);
  console.log(`      finding : ${o.challengeEvidence}`);
  if (o.objection) console.log(`      objection: ${o.objection}`);
}

console.log(`\n${bar}`);
console.log(`  SIGNED OBJECTIONS (${result.signedObjections.length}) — detached ed25519 receipts`);
console.log(bar);
for (const obj of result.signedObjections) {
  console.log(
    `  • ${obj.claimId}  [${obj.challengeType}]  sig ${obj.signature.signature.slice(0, 24)}…  hash ${obj.signature.messageHash.slice(0, 12)}…`,
  );
}

const check = verifyResult(result);
console.log(`\n${bar}`);
console.log(`  INDEPENDENT RE-VERIFICATION`);
console.log(bar);
console.log(`  result signature valid   : ${check.resultValid}`);
console.log(`  all objections valid     : ${check.objectionsValid}`);
console.log(`  execution-log entries    : ${result.executionLog.length}`);
console.log(`  persisted receipt        : demo-output/${result.runId}.json`);
console.log(`${bar}\n`);

if (!check.resultValid || !check.objectionsValid) {
  console.error("SIGNATURE VERIFICATION FAILED");
  process.exit(1);
}
