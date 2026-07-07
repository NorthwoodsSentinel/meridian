/**
 * LIVE wire demo — pull a member's substrate from a REAL Cistern instance and
 * produce a signed, offline-verifiable portable trust receipt. This is the whole
 * pipeline lit up end to end:
 *
 *   Cistern (live intake)  →  cisternMemberLoader  →  RhizomeMembershipAdapter
 *     →  MeridianEngine (adversarial)  →  signed portable trust receipt
 *
 *   CISTERN_BASE=https://cistern.robert-chuvala.workers.dev \
 *   CISTERN_READ_TOKEN=... \
 *   bun run demo-rhizome/cistern-wire-demo.ts <memberId>
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Ed25519Signer,
  JsonFileReceiptStore,
  MeridianEngine,
  RhizomeMembershipAdapter,
  RuleBasedChallengeStrategy,
  buildMembershipClaims,
  cisternMemberLoader,
  runVerification,
  verifyResult,
} from "../src/index.ts";

const baseUrl = process.env.CISTERN_BASE;
const token = process.env.CISTERN_READ_TOKEN;
const memberId = process.argv[2] ?? "aspen-live";
if (!baseUrl || !token) {
  console.error("set CISTERN_BASE and CISTERN_READ_TOKEN in the environment");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const signer = Ed25519Signer.loadOrCreate(join(here, "..", ".meridian-keys"));
const engine = new MeridianEngine({
  strategy: new RuleBasedChallengeStrategy(),
  signer,
  store: new JsonFileReceiptStore(join(here, "..", "demo-output")),
});

const load = cisternMemberLoader({
  baseUrl,
  token,
  source: process.env.CISTERN_SOURCE ?? "rhizome",
});
const adapter = new RhizomeMembershipAdapter({ load });

const result = await runVerification({
  subject: `Rhizome membership — ${memberId} (LIVE via Cistern)`,
  claims: buildMembershipClaims(memberId),
  adapter,
  query: { subjectId: memberId },
  engine,
});

const bar = "═".repeat(72);
const glyph: Record<string, string> = { verified: "✓", flagged: "✗", unresolved: "?" };
console.log(`\n${bar}`);
console.log(`  LIVE PORTABLE TRUST RECEIPT — "${memberId}" (piped from Cistern)`);
console.log(bar);
console.log(`  source      : ${baseUrl}`);
console.log(`  runId       : ${result.runId}`);
console.log(
  `  verified ${result.verifiedCount}  flagged ${result.flaggedCount}  unresolved ${result.unresolvedCount}  →  TRUST ${result.confidenceScore}`,
);
console.log(bar);
for (const o of result.outcomes) {
  console.log(`  [${glyph[o.verdict]}] ${o.claimText}`);
  console.log(`      ${o.challengeEvidence}`);
}
const chk = verifyResult(result);
console.log(`\n  re-verified offline — result ${chk.resultValid}, objections ${chk.objectionsValid}`);
console.log(bar);
if (!chk.resultValid || !chk.objectionsValid) process.exit(1);
