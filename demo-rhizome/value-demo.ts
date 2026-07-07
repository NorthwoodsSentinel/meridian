/**
 * Value-routing demo — the economic layer on top of trust.
 *
 *   bun run demo-rhizome/value-demo.ts
 *
 * Contributor weights stand in for VERIFIED contribution receipts (Meridian only
 * counts what it can corroborate — unverified contributions carry no weight).
 * Given a shared payout, the Shapley value computes the provably-unique fair
 * split. We show two value functions on the same contributors so the design
 * choice is visible: additive (proportional) vs quorum-gated (rewards reaching
 * critical mass).
 */
import { distributePayout, additiveValue, quorumGatedValue, type Contributor } from "../src/index.ts";

const contributors: Contributor[] = [
  { memberId: "aspen", weight: 6 }, // many verified contributions
  { memberId: "birch", weight: 1 },
  { memberId: "cedar", weight: 1 },
  { memberId: "dogwood", weight: 1 },
];
const PAYOUT = 1000;

const bar = "═".repeat(72);
function show(title: string, shares: ReturnType<typeof distributePayout>) {
  console.log(`\n${title}`);
  let total = 0;
  for (const s of shares.sort((a, b) => b.share - a.share)) {
    total += s.share;
    console.log(`  ${s.memberId.padEnd(10)} weight ${String(s.weight).padStart(2)}  →  $${s.share.toFixed(2)}`);
  }
  console.log(`  ${"".padEnd(10)}                Σ = $${total.toFixed(2)}  (efficiency: = payout)`);
}

console.log(bar);
console.log(`  RHIZOME VALUE ROUTING — Shapley split of a $${PAYOUT} payout`);
console.log(bar);
show("ADDITIVE value (proportional to verified contribution):", distributePayout(PAYOUT, contributors, additiveValue));
show("QUORUM-GATED value (co-op needs ≥3 members to produce): ", distributePayout(PAYOUT, contributors, quorumGatedValue(3)));
console.log(`\n${bar}`);
console.log("  Same contributors, two value functions, two fair splits — each the");
console.log("  unique Shapley allocation for its rules. The value function is the");
console.log("  co-op's choice; the fairness is a theorem, not an opinion.");
console.log(bar);
