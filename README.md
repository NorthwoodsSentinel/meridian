# Meridian

A domain-agnostic **adversarial-verification engine**. Hand it a set of **Claims**
and an **EvidenceBundle**; it challenges every claim, signs an objection for anything
that fails, and returns a **confidence-scored, ed25519-signed** verification result
with a full, auditable execution log.

Meridian is the shared core beneath two projects — a cooperative-trust layer
(**Rhizome**) and an enterprise security-audit product. It is built clean and general
so it belongs to neither: it knows only claims, evidence, verdicts, and signatures.

Adapted from the adversarial heart of [`kredence`](https://github.com/daviddao/kredence),
with all onchain / wallet / hypercert / IPFS coupling removed. See `DESIGN.md` for the
exact reuse/adapt/drop mapping and `DECISIONS.md` for build choices.

## The loop

```
Claims + EvidenceBundle
      │
      ▼
for each claim → ChallengeStrategy tries to REFUTE it
      → verdict (verified | flagged | unresolved)
      → per-claim confidence
      → signed objection (ed25519) when not verified
      │
      ▼
confidence score = (verified + 0.5·unresolved) / total
signed result digest + execution log
      │
      ▼
verifyResult() — anyone re-checks it offline, no chain, no network
```

## Quick start

```bash
bun install          # dev deps only (typescript, @types/bun)
bun run demo         # full loop on sample claims/evidence, prints signed result
bun test             # 52 tests
bun run typecheck    # tsc --noEmit, clean
```

## Usage

```ts
import {
  MeridianEngine,
  RuleBasedChallengeStrategy,
  Ed25519Signer,
  LocalJsonEvidenceAdapter,
  runVerification,
  verifyResult,
  type Claim,
} from "./src/index.ts";

const claims: Claim[] = [
  { id: "c1", text: "MFA is enabled.", selfReported: true,
    assertion: { kind: "equals", field: "mfa_enabled", value: true } },
  { id: "c2", text: "At least 20 commits in 90 days.", selfReported: false,
    assertion: { kind: "atLeast", field: "commits_90d", value: 20 } },
];

const engine = new MeridianEngine({
  strategy: new RuleBasedChallengeStrategy(),
  signer: Ed25519Signer.generate(),
});

const result = await runVerification({
  subject: "Acme control audit",
  claims,
  adapter: new LocalJsonEvidenceAdapter({
    inline: [{ kind: "control-config", data: { mfa_enabled: false, commits_90d: 42 } }],
  }),
  query: { subjectId: "acme" },
  engine,
});

console.log(result.confidenceScore);        // 0.5
console.log(verifyResult(result).resultValid); // true
```

## Extending

- **New evidence source** — implement `EvidenceAdapter { id; collect(query) }`.
  `DESIGN.md` sketches a Rhizome-membership adapter and an enterprise-control adapter.
- **New adversary** — implement `ChallengeStrategy { id; challenge(claim, ctx) }`.
  The shipped default is deterministic and hermetic; an LLM- or live-tool-backed
  strategy uses the `tools` registry on `ChallengeContext`. The engine is unchanged
  either way.
- **New persistence** — implement `ReceiptStore { save; load }` (JSON store ships).

## Layout

```
src/
  types.ts               core vocabulary
  engine.ts              MeridianEngine.verify + runVerification + buildResultDigest
  scoring.ts             pure confidence functions (kredence formula)
  signing.ts             Ed25519Signer, canonicalize, verifySignature
  verify.ts              verifyResult — independent re-verification
  log.ts                 ExecutionLog (agent_log-style)
  challenge/             strategy interface + rule-based default + field lookup
  evidence/              adapter interface + LocalJsonEvidenceAdapter stub
  store/                 receipt store interface + JsonFileReceiptStore
demo/                    runnable demo + sample claims/evidence
tests/                   52 unit/integration tests
```

## License

Apache-2.0.
