import { describe, expect, test } from "bun:test";
import {
  EvidenceAuditAdapter,
  buildAuditClaims,
  controlToClaim,
  controlToEvidenceData,
  requirementToAssertion,
  evidenceKindForCategory,
  MeridianEngine,
  RuleBasedChallengeStrategy,
  Ed25519Signer,
  runVerification,
  verifyResult,
} from "../src/index.ts";
import type { ControlSet, SecurityControl } from "../src/index.ts";

/** ISO timestamp `n` days before now — keeps freshness tests independent of the clock. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function engine() {
  return new MeridianEngine({
    strategy: new RuleBasedChallengeStrategy(),
    signer: Ed25519Signer.generate(),
  });
}

/** A control set that fully passes: every claim corroborated by an observation. */
function compliantControlSet(): ControlSet {
  return {
    systemId: "acme-prod",
    label: "Acme — compliant",
    controls: [
      {
        id: "IA-2",
        name: "MFA enforced for admins.",
        category: "identity",
        field: "mfa_enforced",
        claimed: { kind: "equals", value: true },
        observation: { value: true, observedAt: daysAgo(3), source: "okta" },
      },
      {
        id: "AU-11",
        name: "Audit logs retained at least 365 days.",
        category: "logging",
        field: "log_retention_days",
        claimed: { kind: "atLeast", value: 365 },
        observation: { value: 400, observedAt: daysAgo(2) },
      },
      {
        id: "VM-2",
        name: "Vuln scan within 30 days.",
        category: "vuln-mgmt",
        field: "last_vuln_scan",
        claimed: { kind: "freshWithinDays", days: 30 },
        observation: { value: "scan complete", observedAt: daysAgo(5) },
      },
    ],
  };
}

describe("evidenceKindForCategory (pure)", () => {
  test("maps every category to its DESIGN.md evidence kind", () => {
    expect(evidenceKindForCategory("identity")).toBe("access-policy");
    expect(evidenceKindForCategory("access")).toBe("access-policy");
    expect(evidenceKindForCategory("vuln-mgmt")).toBe("vuln-scan");
    expect(evidenceKindForCategory("encryption")).toBe("control-config");
    expect(evidenceKindForCategory("logging")).toBe("control-config");
    expect(evidenceKindForCategory("resilience")).toBe("control-config");
  });
});

describe("requirementToAssertion (pure)", () => {
  test("fuses field + requirement into the exact engine Assertion, per kind", () => {
    expect(requirementToAssertion("f", { kind: "exists" })).toEqual({ kind: "exists", field: "f" });
    expect(requirementToAssertion("f", { kind: "equals", value: true })).toEqual({
      kind: "equals",
      field: "f",
      value: true,
    });
    expect(requirementToAssertion("f", { kind: "atLeast", value: 3 })).toEqual({
      kind: "atLeast",
      field: "f",
      value: 3,
    });
    expect(requirementToAssertion("f", { kind: "atMost", value: 0 })).toEqual({
      kind: "atMost",
      field: "f",
      value: 0,
    });
    expect(requirementToAssertion("f", { kind: "matches", pattern: "^a" })).toEqual({
      kind: "matches",
      field: "f",
      pattern: "^a",
    });
    expect(requirementToAssertion("f", { kind: "freshWithinDays", days: 30 })).toEqual({
      kind: "freshWithinDays",
      field: "f",
      days: 30,
    });
  });
});

describe("controlToClaim (pure transform)", () => {
  test("maps id/text/selfReported/assertion/attributes with evidenceRef present", () => {
    const control: SecurityControl = {
      id: "SC-28",
      name: "Encryption at rest enabled.",
      category: "encryption",
      field: "encryption_at_rest_enabled",
      claimed: { kind: "equals", value: true },
      observation: { value: false, observedAt: daysAgo(1) },
      evidenceRef: "cspm://x",
    };
    const claim = controlToClaim(control);
    expect(claim.id).toBe("SC-28");
    expect(claim.text).toBe("Encryption at rest enabled.");
    expect(claim.selfReported).toBe(false);
    expect(claim.assertion).toEqual({ kind: "equals", field: "encryption_at_rest_enabled", value: true });
    expect(claim.attributes).toEqual({
      controlId: "SC-28",
      category: "encryption",
      check: "security-control",
      evidenceRef: "cspm://x",
    });
  });

  test("selfReported defaults false and evidenceRef is omitted when absent", () => {
    const control: SecurityControl = {
      id: "AC-2",
      name: "Access reviews cover 100% of roles.",
      category: "access",
      field: "access_review_coverage",
      claimed: { kind: "atLeast", value: 100 },
      selfReported: true,
    };
    const claim = controlToClaim(control);
    expect(claim.selfReported).toBe(true);
    expect(claim.attributes).toEqual({
      controlId: "AC-2",
      category: "access",
      check: "security-control",
    });
    expect("evidenceRef" in (claim.attributes ?? {})).toBe(false);
  });
});

describe("controlToEvidenceData (pure)", () => {
  test("returns { field: observedValue } when observed", () => {
    const control: SecurityControl = {
      id: "AU-11",
      name: "retention",
      category: "logging",
      field: "log_retention_days",
      claimed: { kind: "atLeast", value: 365 },
      observation: { value: 400, observedAt: daysAgo(1) },
    };
    expect(controlToEvidenceData(control)).toEqual({ log_retention_days: 400 });
  });

  test("returns null when the control has no observation", () => {
    const control: SecurityControl = {
      id: "AC-2",
      name: "coverage",
      category: "access",
      field: "access_review_coverage",
      claimed: { kind: "atLeast", value: 100 },
    };
    expect(controlToEvidenceData(control)).toBeNull();
  });
});

describe("buildAuditClaims", () => {
  test("builds one claim per control, in order", () => {
    const claims = buildAuditClaims(compliantControlSet());
    expect(claims.map((c) => c.id)).toEqual(["IA-2", "AU-11", "VM-2"]);
  });
});

describe("EvidenceAuditAdapter — normalization", () => {
  test("observed control → one EvidenceItem of the right kind carrying field=value at scan time", async () => {
    const set = compliantControlSet();
    const bundle = await new EvidenceAuditAdapter({ inline: set }).collect({ subjectId: "acme-prod" });

    expect(bundle.adapterId).toBe("evidence-audit");
    expect(bundle.subjectId).toBe("acme-prod");
    expect(bundle.items).toHaveLength(3);
    expect(bundle.failures).toHaveLength(0);

    const mfa = bundle.items.find((i) => i.source === "okta")!;
    expect(mfa.kind).toBe("access-policy");
    expect(mfa.data.mfa_enforced).toBe(true);
    expect(mfa.observedAt).toBe(set.controls[0]!.observation!.observedAt);

    const vuln = bundle.items.find((i) => i.kind === "vuln-scan")!;
    expect(vuln.data.last_vuln_scan).toBe("scan complete");
    // No explicit source → derived from category.
    expect(vuln.source).toBe("audit:vuln-mgmt");
  });

  test("a control with no observation contributes no evidence item", async () => {
    const set: ControlSet = {
      systemId: "s",
      controls: [
        {
          id: "AC-2",
          name: "coverage",
          category: "access",
          field: "access_review_coverage",
          claimed: { kind: "atLeast", value: 100 },
          selfReported: true,
        },
      ],
    };
    const bundle = await new EvidenceAuditAdapter({ inline: set }).collect({ subjectId: "s" });
    expect(bundle.items).toHaveLength(0);
    expect(bundle.failures).toHaveLength(0);
  });

  test("duplicate observed field → a recorded failure, not a thrown crash", async () => {
    const set: ControlSet = {
      systemId: "s",
      controls: [
        {
          id: "C1",
          name: "one",
          category: "logging",
          field: "enabled",
          claimed: { kind: "equals", value: true },
          observation: { value: true, observedAt: daysAgo(1) },
        },
        {
          id: "C2",
          name: "two",
          category: "encryption",
          field: "enabled",
          claimed: { kind: "equals", value: true },
          observation: { value: false, observedAt: daysAgo(1) },
        },
      ],
    };
    const bundle = await new EvidenceAuditAdapter({ inline: set }).collect({ subjectId: "s" });
    // Both items still emitted deterministically, in order.
    expect(bundle.items).toHaveLength(2);
    expect(bundle.failures).toHaveLength(1);
    expect(bundle.failures[0]!.source).toBe("evidence-audit:C2");
    expect(bundle.failures[0]!.reason).toContain('Duplicate observed field "enabled"');
    expect(bundle.failures[0]!.reason).toContain("C1");
  });

  test("pluggable load() source is honored (the CSPM / IdP / scanner seam)", async () => {
    let askedFor = "";
    const adapter = new EvidenceAuditAdapter({
      load: async (subjectId) => {
        askedFor = subjectId;
        return compliantControlSet();
      },
    });
    const bundle = await adapter.collect({ subjectId: "acme-prod" });
    expect(askedFor).toBe("acme-prod");
    expect(bundle.items.length).toBeGreaterThan(0);
  });

  test("a failing source is a recorded failure, not a thrown crash", async () => {
    const adapter = new EvidenceAuditAdapter({
      load: () => {
        throw new Error("cspm export unreachable");
      },
    });
    const bundle = await adapter.collect({ subjectId: "acme-prod" });
    expect(bundle.items).toHaveLength(0);
    expect(bundle.failures).toHaveLength(1);
    expect(bundle.failures[0]!.reason).toContain("cspm export unreachable");
    expect(bundle.failures[0]!.source).toBe("evidence-audit:loader");
  });
});

describe("end-to-end audit verification", () => {
  test("a fully compliant control set scores 1 and re-verifies offline", async () => {
    const set = compliantControlSet();
    const result = await runVerification({
      subject: set.label ?? set.systemId,
      claims: buildAuditClaims(set),
      adapter: new EvidenceAuditAdapter({ inline: set }),
      query: { subjectId: set.systemId },
      engine: engine(),
    });

    expect(result.verifiedCount).toBe(3);
    expect(result.flaggedCount).toBe(0);
    expect(result.confidenceScore).toBe(1);

    const check = verifyResult(result);
    expect(check.resultValid).toBe(true);
    expect(check.objectionsValid).toBe(true);
  });

  test("an observed value violating equals flags with a signed objection citing the value", async () => {
    const set: ControlSet = {
      systemId: "acme-prod",
      controls: [
        {
          id: "SC-28",
          name: "Encryption at rest enabled.",
          category: "encryption",
          field: "encryption_at_rest_enabled",
          claimed: { kind: "equals", value: true },
          observation: { value: false, observedAt: daysAgo(1) },
          evidenceRef: "cspm://rds",
        },
      ],
    };
    const result = await runVerification({
      subject: "acme",
      claims: buildAuditClaims(set),
      adapter: new EvidenceAuditAdapter({ inline: set }),
      query: { subjectId: set.systemId },
      engine: engine(),
    });
    const gap = result.outcomes.find((o) => o.claimId === "SC-28")!;
    expect(gap.verdict).toBe("flagged");
    expect(gap.challengeType).toBe("contradicted");
    expect(gap.objection).toBeString();
    expect(result.signedObjections.some((o) => o.claimId === "SC-28")).toBe(true);
    // The signed objection is offline-verifiable.
    expect(verifyResult(result).objectionsValid).toBe(true);
  });

  test("criticals over the atMost bound flag as overclaim", async () => {
    const set: ControlSet = {
      systemId: "acme-prod",
      controls: [
        {
          id: "RA-5",
          name: "Zero open critical vulnerabilities.",
          category: "vuln-mgmt",
          field: "critical_vuln_count",
          claimed: { kind: "atMost", value: 0 },
          observation: { value: 3, observedAt: daysAgo(1) },
        },
      ],
    };
    const result = await runVerification({
      subject: "acme",
      claims: buildAuditClaims(set),
      adapter: new EvidenceAuditAdapter({ inline: set }),
      query: { subjectId: set.systemId },
      engine: engine(),
    });
    const gap = result.outcomes.find((o) => o.claimId === "RA-5")!;
    expect(gap.verdict).toBe("flagged");
    expect(gap.challengeType).toBe("overclaim");
  });

  test("a stale observation flags via freshWithinDays while a sibling stays verified", async () => {
    const set: ControlSet = {
      systemId: "acme-prod",
      controls: [
        {
          id: "CP-9",
          name: "Backup restore tested within 90 days.",
          category: "resilience",
          field: "last_backup_test",
          claimed: { kind: "freshWithinDays", days: 90 },
          observation: { value: "restore drill", observedAt: daysAgo(200) },
        },
        {
          id: "IA-2",
          name: "MFA enforced for admins.",
          category: "identity",
          field: "mfa_enforced",
          claimed: { kind: "equals", value: true },
          observation: { value: true, observedAt: daysAgo(2) },
        },
      ],
    };
    const result = await runVerification({
      subject: "acme",
      claims: buildAuditClaims(set),
      adapter: new EvidenceAuditAdapter({ inline: set }),
      query: { subjectId: set.systemId },
      engine: engine(),
    });
    const stale = result.outcomes.find((o) => o.claimId === "CP-9")!;
    expect(stale.verdict).toBe("flagged");
    expect(stale.challengeType).toBe("stale");
    // Per-claim honesty: a good control still verifies in the same run.
    expect(result.outcomes.find((o) => o.claimId === "IA-2")!.verdict).toBe("verified");
  });

  test("a self-reported metric control with no observation flags as unsupported", async () => {
    const set: ControlSet = {
      systemId: "acme-prod",
      controls: [
        {
          id: "AC-2",
          name: "Least-privilege access reviews cover 100% of admin roles.",
          category: "access",
          field: "access_review_coverage",
          claimed: { kind: "atLeast", value: 100 },
          selfReported: true,
        },
      ],
    };
    const result = await runVerification({
      subject: "acme",
      claims: buildAuditClaims(set),
      adapter: new EvidenceAuditAdapter({ inline: set }),
      query: { subjectId: set.systemId },
      engine: engine(),
    });
    const gap = result.outcomes.find((o) => o.claimId === "AC-2")!;
    expect(gap.verdict).toBe("flagged");
    expect(gap.challengeType).toBe("unsupported");
  });
});
