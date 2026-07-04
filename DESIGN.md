# Meridian — Design Note

Meridian is a domain-agnostic **adversarial-verification engine**. You hand it a
set of **Claims** and an **EvidenceBundle**; it challenges every claim, signs an
objection for anything that fails, and returns a **confidence-scored, ed25519-signed
verification result** with a full execution log.

It is a clean-room adaptation of the adversarial heart of David Dao's
[`kredence`](https://github.com/daviddao/kredence), generalized so the *same core*
can serve two of Rob's projects without modification:

- **Rhizome** — cooperative-trust attestations between members.
- **Enterprise security audit** — verifying control claims against observed config.

The engine deliberately knows about neither. It knows only claims, evidence,
verdicts, and signatures.

---

## The heart we kept

kredence's pipeline is Scout → Evidence → **Adversarial** → Synthesis. The value —
and what Meridian preserves exactly — is the Adversarial + scoring core:

> Take claims, gather evidence, adversarially try to **refute** each claim, and emit
> a **confidence score** plus a **signed objection** for anything that fails.

Concretely, from `packages/agents/src/adversarial/`:

| kredence | Meridian | What carried over |
|---|---|---|
| `challenge.ts` → `challengeClaims()` | `challenge/ruleBased.ts` → `RuleBasedChallengeStrategy` | Per-claim verdict of **verified / flagged / unresolved**, a **challengeType**, **challengeEvidence** ("what I found"), and an **objection required whenever not verified**. |
| `sign.ts` → `signAdversarialLog()` | `signing.ts` → `Ed25519Signer` + `engine.ts` signing step | A **canonical message → hash → detached signature** receipt. Canonicalization (sorted keys) is preserved so a verifier can re-derive and check. |
| `adversarial/index.ts` confidence line `(verified + 0.5·unresolved)/total` | `scoring.ts` → `computeConfidenceScore()` | The **exact** confidence formula, rounded to 2dp, kept for semantic parity. |
| `logger.ts` → `AgentLogger` | `log.ts` → `ExecutionLog` | The **agent_log-style** structured, streamable execution trace (`onEntry` callback preserved). |
| `evidence/claims.ts` `ExtractedClaim` shape | `types.ts` → `Claim` | `text` + `source`/`selfReported` provenance; the "self-reported metric with no corroboration → flag" instinct. |
| Storacha `uploadJSON` → CID | `store/jsonFileStore.ts` → local JSON path | Persist the receipt; address it by id. Chain-free. |

## What we adapted

**(a) Evidence source is pluggable.** kredence hardcodes GitHub / website / onchain
collectors inside its Evidence agent. Meridian inverts this: the engine takes an
abstract `EvidenceAdapter` (`evidence/adapter.ts`). The adversarial core never
imports a collector. One concrete stub ships — `LocalJsonEvidenceAdapter` — reading
normalized items from JSON for the demo and tests. Rhizome and enterprise adapters
(sketched below) plug into the identical seam.

**The adversary is pluggable too.** kredence's challenger *is* a single LLM call.
Meridian keeps the same contract (in: claim + evidence + tools → out: verdict +
objection + confidence) but behind a `ChallengeStrategy` interface. The shipped
default (`RuleBasedChallengeStrategy`) is **deterministic and hermetic** — no LLM,
no network — so the engine is safe to run unsupervised and its tests are
reproducible. An LLM-backed or live-tool-backed strategy can drop in later via the
`tools` registry on `ChallengeContext` (the "any tool it's given" seam) without
touching the engine.

**Structured assertions.** To refute deterministically, a claim may carry a
machine-checkable `Assertion` (`exists` / `equals` / `atLeast` / `atMost` /
`matches` / `freshWithinDays`) evaluated against evidence by dot-path. This is the
deterministic analogue of what kredence asked its LLM to reason about (thresholds,
staleness, contradiction). Claims with no assertion fall back to the same heuristic
kredence used in prose: a self-reported specific metric with nothing to corroborate
it gets **flagged**; anything genuinely indeterminate becomes **unresolved** — never
a silent pass.

## What we dropped (entirely)

- **All onchain / token / hypercert / Storacha coupling.** No `viem`, no
  `baseSepolia`, no `OPERATOR_PRIVATE_KEY` wallet, no `evidence/onchain.ts`, no
  `hypercerts/publish.ts`, no ATProto, no IPFS/Storacha uploads, no CIDs.
- **EIP-191 wallet signing** → replaced by local **ed25519** (`node:crypto`).
  Same receipt guarantee (anyone can re-derive the message and verify the
  signature), zero chain.
- **The Scout and Synthesis agents.** Scouting (discovering projects from
  hackathon ecosystems) and hypercert-payload assembly are domain features, not the
  verification core. Meridian is only the middle.
- **LLM claim extraction.** In Meridian, claims are an *input*. (A future adapter or
  a pre-step could generate them; the engine stays agnostic.)

---

## Architecture

```
                 ┌──────────────────┐
   query ─────▶  │ EvidenceAdapter  │ ──▶ EvidenceBundle
                 │  (pluggable)     │        │
                 └──────────────────┘        │
                                             ▼
  Claims ────────────────────────▶  ┌─────────────────────┐
                                     │   MeridianEngine    │
                                     │                     │
                                     │  for each claim:    │
                    ChallengeStrategy│   challenge() ──────┼──▶ ChallengeOutcome
                     (pluggable) ───▶│   if !verified:     │      (verdict, type,
                                     │     sign objection ─┼──▶    confidence, objection)
                                     │  score (kredence)   │
              Signer (ed25519) ─────▶│  sign result digest │
                                     │  persist (optional) │
              ReceiptStore ─────────▶│                     │
               (pluggable)           └─────────┬───────────┘
                                               ▼
                                    VerificationResult
                                    (signed, scored, +execution log)
                                               │
                                               ▼
                                     verifyResult()  ← anyone, offline
```

### Modules

- `src/types.ts` — the whole vocabulary: `Claim`, `Assertion`, `EvidenceItem`/`EvidenceBundle`, `ChallengeOutcome`, `SignedObjection`, `VerificationResult`, `Signature`, `ExecutionLogEntry`.
- `src/engine.ts` — `MeridianEngine.verify()` (the loop) + `runVerification()` (adapter → verify) + `buildResultDigest()` (what the signature covers).
- `src/challenge/strategy.ts` — `ChallengeStrategy` interface + `ChallengeContext` (bundle + `tools` registry + log).
- `src/challenge/ruleBased.ts` — deterministic default adversary.
- `src/challenge/evidenceQuery.ts` — dot-path field lookup + staleness helper.
- `src/scoring.ts` — pure confidence functions (kredence formula).
- `src/signing.ts` — `Ed25519Signer`, `canonicalize`, `verifySignature`.
- `src/verify.ts` — `verifyResult()`: independent re-verification of a signed result.
- `src/log.ts` — `ExecutionLog` (agent_log-style).
- `src/evidence/adapter.ts` + `localJson.ts` — evidence seam + stub adapter.
- `src/store/receiptStore.ts` + `jsonFileStore.ts` — persistence seam + local store.

### Confidence: two distinct numbers

- **Per-claim `confidence` (0..1)** — the challenger's certainty in the verdict it
  assigned a single claim. Lives on each `ChallengeOutcome`.
- **Result `confidenceScore` (0..1)** — trust in the whole claim set:
  `(verifiedCount + 0.5·unresolvedCount) / total`, rounded 2dp. kredence's exact
  formula. Higher = more trustworthy subject.

Keeping them separate avoids conflating "how sure the engine is about one verdict"
with "how trustworthy the subject is overall."

### The signed result

`buildResultDigest()` canonicalizes the load-bearing subset — runId, subject/adapter/
strategy ids, the score, and per-claim `{claimId, verdict, challengeType, confidence}`.
The ed25519 signature covers that digest, so flipping any verdict (e.g. faking a
`flagged` into `verified` to inflate the score) breaks the signature. Each flagged/
unresolved claim additionally carries its own `SignedObjection` receipt. `verifyResult()`
re-derives both offline from the public keys embedded in the signatures — no engine,
no network, no chain required.

---

## How the two future adapters plug in

Both implement `EvidenceAdapter { id; collect(query) → EvidenceBundle }`. Neither
requires any change to the engine, the strategy interface, scoring, or signing.

### Rhizome-membership adapter (cooperative trust)

- **Subject**: a member (or a member's contribution/attestation).
- **`collect()`**: pull the member's substrate — attestations from peers, contribution
  receipts, participation history, prior signed Meridian results — and normalize each
  into an `EvidenceItem` (`kind: "peer-attestation"`, `"contribution-receipt"`,
  `"participation-log"`; `observedAt` = attestation time).
- **Claims** a member makes ("I contributed X", "I've been active since Y", "N peers
  vouch for me") carry assertions like `atLeast field:"vouches" value:3` or
  `freshWithinDays field:"last_contribution" days:90`.
- The rule-based strategy already refutes these. `selfReported: true` on a member's
  own claims means an uncorroborated metric flags — exactly the trust hygiene Rhizome
  wants. The signed result becomes a **portable trust receipt** a member carries
  between cooperatives.
- A later LLM strategy could additionally judge free-text attestations; it slots into
  `ChallengeStrategy` with no engine change.

### Enterprise-audit-control adapter (security audit product)

- **Subject**: a system, control set, or vendor.
- **`collect()`**: pull observed state from control planes / scanners / config APIs
  (CSPM export, IdP config, vuln-scan results, IaC state) and normalize each into an
  `EvidenceItem` (`kind: "control-config"`, `"vuln-scan"`, `"access-policy"`;
  `observedAt` = scan time — staleness matters here).
- **Claims** are the audit assertions ("MFA is enforced", "criticals ≤ 0", "scanned
  within 30 days", "≥ 99.9% uptime") — precisely the demo's shape. `equals`,
  `atMost`, `freshWithinDays`, `atLeast` cover the common control language.
- Output is a **signed audit receipt**: verified controls, flagged gaps each with a
  signed objection citing the actual observed value, and a confidence score for the
  control set. The demo (`demo/`) is deliberately written in this register to show
  the fit.

The demo proves the whole loop with `LocalJsonEvidenceAdapter`; swapping in either
adapter above is a new file implementing one method.
