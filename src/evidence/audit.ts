/**
 * EvidenceAuditAdapter — the enterprise-security-audit twin of the Rhizome
 * membership adapter. It turns a client's declared security **control set** into
 * an EvidenceBundle the engine can adversarially challenge. The signed result the
 * engine returns *is* the client's portable **audit receipt** — a thing a CISO,
 * board, or regulator can re-verify offline, with a signed objection citing the
 * actual observed value for every gap.
 *
 * The engine never learns it is doing "security audit". It sees claims + evidence,
 * exactly as it does for the co-op trust demo. All audit-specific knowledge lives
 * in this one file, behind the identical `EvidenceAdapter` seam. See DESIGN.md
 * ("Enterprise-audit-control adapter") for the sketch this implements.
 *
 * THE AUDIT MODEL — claimed vs. observed. A real adversarial audit checks the
 * *claimed* state (what a vendor questionnaire / control owner declares is true)
 * against the *independently observed* state (what a scanner, IdP, CSPM export, or
 * config API actually reports). So each control carries BOTH:
 *   - `claimed`     → the required state, becomes the Claim's structured assertion.
 *   - `observation` → the independently observed value, becomes the EvidenceItem.
 * When observed satisfies claimed → verified. When observed violates claimed →
 * flagged, with a signed objection citing the real value. A `selfReported` control
 * with no observation is the vendor-questionnaire case: an uncorroborated metric
 * flags — exactly the audit hygiene a security review needs.
 *
 * SOURCE IS PLUGGABLE, like the Rhizome adapter. This adapter never fetches. It is
 * handed a `ControlSetSource` that yields a normalized `ControlSet`:
 *   - `{ inline }`   — a control set already in memory (tests, demo).
 *   - `{ filePath }` — a JSON file on disk (demo fixtures).
 *   - `{ load }`     — an async loader. THIS is the real seam: a CSPM export reader,
 *                      an IdP config puller, a vuln-scan API client drops in here
 *                      without touching this adapter.
 *
 * Normalization, per DESIGN.md — each observed control → one EvidenceItem whose
 * `kind` reflects the control category (`"control-config"`, `"vuln-scan"`,
 * `"access-policy"`), `observedAt` = the scan time (staleness matters here), and
 * `data` carries `{ [control.field]: observation.value }` so the control's
 * assertion has a field to bind to.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Assertion, Claim, EvidenceBundle, EvidenceItem } from "../types.ts";
import type { EvidenceAdapter, EvidenceQuery } from "./adapter.ts";

/** The control families a v0 audit covers. Each maps to an evidence `kind`. */
export type ControlCategory =
  | "identity" // MFA, SSO, admin auth
  | "encryption" // at-rest / in-transit
  | "logging" // audit-log retention, trails
  | "access" // least-privilege, access reviews, offboarding
  | "resilience" // backups, DR, restore tests
  | "vuln-mgmt"; // scan cadence, critical-finding counts

/**
 * The claimed/required state of a control. This is the `Assertion` taxonomy minus
 * the `field` — the field lives on the control, and `requirementToAssertion` fuses
 * the two into the engine's `Assertion` shape.
 */
export type ControlRequirement =
  | { kind: "exists" }
  | { kind: "equals"; value: string | number | boolean }
  | { kind: "atLeast"; value: number }
  | { kind: "atMost"; value: number }
  | { kind: "matches"; pattern: string }
  | { kind: "freshWithinDays"; days: number };

/** The independently observed state of a control, from a scan / control-plane. */
export type ControlObservation = {
  /** The observed value. Compared against the control's `claimed` requirement. */
  value: unknown;
  /** ISO-8601 scan time. Drives `freshWithinDays` staleness — authoritative, not invented. */
  observedAt: string;
  /** Which scanner / control-plane produced it. Defaults to `audit:<category>`. */
  source?: string;
};

/** One declared security control: what is required, and what was observed. */
export type SecurityControl = {
  /**
   * Stable control id, e.g. "IA-2", "SC-28". Unique within a set and used as the
   * Claim id, so a flagged control reads back as "IA-2 flagged" on the receipt.
   */
  id: string;
  /** Human-readable control name, e.g. "MFA enforced for all admin accounts". */
  name: string;
  category: ControlCategory;
  /**
   * The observed-signal field this control checks, e.g. "mfa_enforced". SHOULD be
   * unique across observed controls in a set; a collision is surfaced as a bundle
   * `failures` entry (see `collect`) rather than silently mis-binding a claim.
   */
  field: string;
  /** The claimed/required state — becomes the Claim's structured assertion. */
  claimed: ControlRequirement;
  /**
   * The independently observed state. Absent = not observed: the claim then
   * resolves `unresolved` (or `flagged` if it is a self-reported metric), never a
   * silent pass.
   */
  observation?: ControlObservation;
  /**
   * True when the only source is a vendor questionnaire / self-attestation with no
   * independent observation. An uncorroborated self-reported metric flags. Default false.
   */
  selfReported?: boolean;
  /** Optional pointer to the raw scanner artifact backing the observation. */
  evidenceRef?: string;
};

/** A client's full declared control set — the adapter's input contract. */
export type ControlSet = {
  /** Stable id of the audited system / vendor. Should match the query subjectId. */
  systemId: string;
  /** Human-readable label for the audited system. */
  label?: string;
  controls: SecurityControl[];
};

/**
 * Where the control set comes from. The `load` form is the production seam: point
 * it at a CSPM export / IdP config / vuln-scan API and this adapter is unchanged.
 */
export type ControlSetSource =
  | { inline: ControlSet }
  | { filePath: string }
  | { load: (subjectId: string) => ControlSet | Promise<ControlSet> };

/** Map a control category to the evidence `kind` DESIGN.md names for it. */
export function evidenceKindForCategory(category: ControlCategory): string {
  switch (category) {
    case "vuln-mgmt":
      return "vuln-scan";
    case "identity":
    case "access":
      return "access-policy";
    case "encryption":
    case "logging":
    case "resilience":
      return "control-config";
    default: {
      // Exhaustiveness guard — a new category must be mapped explicitly.
      const _never: never = category;
      throw new Error(`Unhandled control category: ${JSON.stringify(_never)}`);
    }
  }
}

/** Fuse a control's `field` with its `claimed` requirement into an engine `Assertion`. */
export function requirementToAssertion(field: string, req: ControlRequirement): Assertion {
  switch (req.kind) {
    case "exists":
      return { kind: "exists", field };
    case "equals":
      return { kind: "equals", field, value: req.value };
    case "atLeast":
      return { kind: "atLeast", field, value: req.value };
    case "atMost":
      return { kind: "atMost", field, value: req.value };
    case "matches":
      return { kind: "matches", field, pattern: req.pattern };
    case "freshWithinDays":
      return { kind: "freshWithinDays", field, days: req.days };
    default: {
      // Exhaustiveness guard — a new requirement kind must be handled explicitly.
      const _never: never = req;
      throw new Error(`Unhandled control requirement: ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * The evidence `data` shape for one control: `{ [field]: observedValue }` when the
 * control has an observation, else `null` (an unobserved control contributes no
 * evidence). Pure and deterministic — the adapter wraps this with id/kind/source/
 * observedAt; tests assert the shaping contract directly.
 */
export function controlToEvidenceData(control: SecurityControl): Record<string, unknown> | null {
  if (control.observation === undefined) return null;
  return { [control.field]: control.observation.value };
}

/**
 * Transform one control into the engine's `Claim`. Pure and deterministic (no
 * UUID) so the control → Claim mapping is unit-testable in isolation.
 */
export function controlToClaim(control: SecurityControl): Claim {
  return {
    id: control.id,
    text: control.name,
    selfReported: control.selfReported ?? false,
    assertion: requirementToAssertion(control.field, control.claimed),
    attributes: {
      controlId: control.id,
      category: control.category,
      check: "security-control",
      ...(control.evidenceRef !== undefined ? { evidenceRef: control.evidenceRef } : {}),
    },
  };
}

/**
 * Build the audit Claims for a control set — one per control. The signed
 * VerificationResult produced from these claims IS the client's portable audit
 * receipt. Mirrors `buildMembershipClaims` for the Rhizome adapter.
 */
export function buildAuditClaims(controlSet: ControlSet): Claim[] {
  return controlSet.controls.map(controlToClaim);
}

export class EvidenceAuditAdapter implements EvidenceAdapter {
  readonly id = "evidence-audit";
  #source: ControlSetSource;

  constructor(source: ControlSetSource) {
    this.#source = source;
  }

  async collect(query: EvidenceQuery): Promise<EvidenceBundle> {
    const collectedAt = new Date().toISOString();

    // ── Resolve the control set from the pluggable source. A failure is recorded,
    //    never thrown — the engine can still run and every claim becomes unresolved. ──
    let controlSet: ControlSet;
    try {
      controlSet = await this.#resolve(query.subjectId);
    } catch (err) {
      return {
        subjectId: query.subjectId,
        collectedAt,
        adapterId: this.id,
        items: [],
        failures: [
          { source: this.#sourceLabel(), reason: err instanceof Error ? err.message : String(err) },
        ],
      };
    }

    const items: EvidenceItem[] = [];
    const failures: EvidenceBundle["failures"] = [];
    // Track observed fields so a collision surfaces loudly instead of a silent mis-bind.
    const fieldOwner = new Map<string, string>();

    for (const control of controlSet.controls) {
      const obs = control.observation;
      if (obs === undefined) continue; // unobserved control contributes no evidence

      const priorOwner = fieldOwner.get(control.field);
      if (priorOwner !== undefined) {
        // Two observed controls share a field: findField would bind a claim to the
        // first item, which may be the wrong control. Surface it, keep going in
        // order so behavior stays deterministic.
        failures.push({
          source: `evidence-audit:${control.id}`,
          reason: `Duplicate observed field "${control.field}" also declared by control "${priorOwner}"; a claim on this field may bind to the wrong control's evidence. Give each observed control a distinct field.`,
        });
      } else {
        fieldOwner.set(control.field, control.id);
      }

      items.push({
        id: randomUUID(),
        source: obs.source ?? `audit:${control.category}`,
        kind: evidenceKindForCategory(control.category),
        observedAt: obs.observedAt,
        // Shape matches controlToEvidenceData(control) — kept inline so the item
        // build reads straight through without a null-narrowing dance.
        data: { [control.field]: obs.value },
      });
    }

    return { subjectId: query.subjectId, collectedAt, adapterId: this.id, items, failures };
  }

  async #resolve(subjectId: string): Promise<ControlSet> {
    if ("inline" in this.#source) return this.#source.inline;
    if ("load" in this.#source) return this.#source.load(subjectId);
    // filePath form: a missing/corrupt file surfaces as a caught failure upstream.
    return JSON.parse(readFileSync(this.#source.filePath, "utf8")) as ControlSet;
  }

  #sourceLabel(): string {
    if ("filePath" in this.#source) return this.#source.filePath;
    if ("load" in this.#source) return "evidence-audit:loader";
    return "evidence-audit:inline";
  }
}
