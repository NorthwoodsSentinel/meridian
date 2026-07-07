# Rhizome Wiring — the layer that computes trust between members

This is the plan of record for wiring Meridian into the Rhizome co-op. It is the
first real thing plugged into the adversarial-verification engine. Trust used to
be the one unfinished piece. It runs now.

## What got built

The Rhizome-membership adapter. It turns a co-op member's own substrate into
evidence the Meridian engine can challenge. The engine did not change. Not one
line. The whole co-op-specific brain lives in a single new file behind the same
seam the enterprise-audit demo uses.

A member has three kinds of substrate. Peers who vouch for them. Receipts that
they contributed something real. A log of showing up. The adapter reads all
three and hands the engine a normalized evidence bundle. The engine then
challenges the standard membership claims, signs an objection for anything that
fails, and returns a confidence-scored, ed25519-signed result.

That signed result is the point. It is the member's **portable trust receipt**.
They carry it between cooperatives. Anyone can re-verify it offline with nothing
but the file — no engine, no network, no chain. `verifyResult()` re-derives every
signature from the public keys baked into them.

## The full pipeline

Read it left to right. Each stage owns one job.

**Cistern** is the raw intake. Already built. It pulls a member's substrate into
episodes — the vouches, the receipts, the participation events — and holds them
raw, no summarizing, no smoothing. That rawness is the whole design. A summarizer
in the middle is the failure mode this stack exists to avoid.

**The Rhizome-membership adapter** normalizes what Cistern holds. Each substrate
entry becomes one evidence item. It also derives two rollups so the membership
thresholds have a concrete field to bind to: a vouch count (distinct vouchers —
a peer vouching five times is still one vouch) and a last-contribution timestamp.
The rollups cite exactly what they summarize and are marked derived. Nothing is
invented.

**The Meridian engine** computes trust. It challenges every claim adversarially —
it tries to refute, and only concedes "verified" when independent evidence backs
the claim. Enough vouches, or the claim flags. A fresh contribution, or it flags
stale. A self-reported number with nothing to corroborate it, and it flags as
unsupported. That last one is the trust hygiene the co-op wants: a member cannot
talk their way in, the evidence has to be there.

**The portable trust receipt** is the output. Signed, scored, re-verifiable
anywhere. A member carries it to the next cooperative and that cooperative checks
it in seconds without trusting us at all.

The demo in `demo-rhizome/` runs two members through the whole thing. Aspen has
four vouchers, a fresh contribution, and a self-report the evidence actually backs
— clean receipt, trust score 1.0. Birch has one voucher, a contribution from six
months ago, and a self-reported claim to have written 8000 lines with zero
receipts — every claim flagged, each with its own signed objection, trust score
0.0. Same engine, same code path, opposite outcomes, both provable.

## The source is not hardcoded

The adapter never fetches. It is handed a source that yields the normalized member
shape. Today that source is plain JSON — a file or an in-memory object. The real
seam is a `load()` function. Point that function at Cistern episodes, or the
daemon canonical store, or an ATProto/DID resolver, and the adapter does not
change. Swapping where trust data physically lives is a new loader, not a rewrite.

## The next seam: value-routing

Trust is done. The follow-on is fair value-flow between members. Once you can
compute who is a real, active, corroborated member — and you now can — the next
question is how value moves between them. Who gets what when the co-op earns.
How a contribution receipt turns into a claim on shared value. That is a separate
layer with its own decisions, and it is deliberately not built yet. Trust first,
because value-routing that runs on unverified membership is just a nicer-looking
way to get gamed.

## Three decisions — DECIDED 2026-07-06 ("execute it")

Rob green-lit shipping at defaults. Locked, all overridable later (they are data,
not buried logic):
- **#1 threshold** → shipped at 3 distinct vouches / 1 contribution / 90-day freshness.
- **#2 substrate source** → default **Cistern** via the pluggable `load()` loader (the live intake, deployed 2026-07-06). Daemon and ATProto remain drop-in alternatives — a new loader, not a rewrite. Live Cistern-read loader is the one remaining wire (needs a Cistern read endpoint; write-side is live, read-side is the next small seam).
- **#3 value-routing (Shapley)** → NOT decided-away. It is the named *next build*, deliberately after trust. Unchanged.

Original framing and rationale for each below.

**1. The membership threshold.** Currently a member in good standing needs at
least 3 distinct peer vouches and at least 1 contribution receipt within the last
90 days. Both numbers live in `DEFAULT_MEMBERSHIP_POLICY` and can be passed per
call. Rob decides whether 3 is right, whether it should scale with co-op size,
whether a brand-new member gets a grace window before the freshness clock starts.

**2. Where member substrate physically lives.** Right now it is source-agnostic
JSON, read through a pluggable loader. The real options are Cistern episodes, the
daemon canonical store, or ATProto/DIDs. Each has a different sovereignty and
portability story. The adapter is built to not care, so Rob can pick — or run more
than one — without touching this code. This is a "which substrate" call, not a
"rewrite the adapter" call.

**3. The value-routing model.** The next seam to *build*, but no longer an open
*theoretical* question — it has a named answer: the **Shapley value** (cooperative
game theory, Lloyd Shapley 1953). It is the provably-unique fair split of a shared
payout: the four axioms (efficiency, symmetry, null-player, additivity) pin down
exactly one allocation, so "here is what you are objectively owed" is a theorem, not
the co-op's opinion — the one promise a platform revenue-share can never make.
David Dao's PhD *is* Data Shapley plus the efficiency work that makes it tractable
(exact Shapley is exponential). And the inputs are already here: Meridian's signed
contribution receipts are exactly what a Shapley computation consumes. So the engine
is Cistern (intake) → Meridian (trust: whose contribution, is it real, signed) →
Shapley (value: what it is worth on a payout, signed). Open design question that
remains: the *value function* — how to measure the product's worth with vs. without
a given contributor — for code/pattern/substrate, not just the ML-data setting
David's papers assume. Named here so it lands on the settled trust layer, not before.

## Files

- `src/rhizome/types.ts` — the member-substrate shape (the adapter's input contract) and the co-op policy defaults.
- `src/evidence/rhizome.ts` — `RhizomeMembershipAdapter` and `buildMembershipClaims()`.
- `demo-rhizome/` — two members, one clean, one flagged, run end to end.
- `tests/rhizome.test.ts` — normalization, scoring, flagging, and offline re-verification.
