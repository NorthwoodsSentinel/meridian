import { describe, expect, test } from "bun:test";
import { RuleBasedChallengeStrategy } from "../src/challenge/ruleBased.ts";
import type { ChallengeContext } from "../src/challenge/strategy.ts";
import { ExecutionLog } from "../src/log.ts";
import type { Claim, EvidenceBundle, EvidenceItem } from "../src/types.ts";

const strategy = new RuleBasedChallengeStrategy();

function bundle(items: Partial<EvidenceItem>[]): EvidenceBundle {
  return {
    subjectId: "subject",
    collectedAt: new Date().toISOString(),
    adapterId: "test",
    items: items.map((it, i) => ({
      id: it.id ?? `item-${i}`,
      source: it.source ?? "test",
      kind: it.kind ?? "generic",
      observedAt: it.observedAt ?? new Date().toISOString(),
      data: it.data ?? {},
    })),
    failures: [],
  };
}

function ctx(b: EvidenceBundle): ChallengeContext {
  return { bundle: b, tools: {}, log: new ExecutionLog() };
}

function claim(partial: Partial<Claim> & Pick<Claim, "id" | "text">): Claim {
  return { selfReported: false, ...partial };
}

const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("RuleBasedChallengeStrategy — structured assertions", () => {
  test("exists → verified when field present", () => {
    const b = bundle([{ data: { repo_url: "https://x" } }]);
    const o = strategy.challenge(
      claim({ id: "1", text: "has repo", assertion: { kind: "exists", field: "repo_url" } }),
      ctx(b),
    );
    expect(o.verdict).toBe("verified");
    expect(o.objection).toBeNull();
  });

  test("equals → verified on match", () => {
    const b = bundle([{ data: { mfa_enabled: true } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "mfa on",
        assertion: { kind: "equals", field: "mfa_enabled", value: true },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("verified");
  });

  test("equals → flagged/contradicted on mismatch, objection cites actual value", () => {
    const b = bundle([{ data: { mfa_enabled: false } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "mfa on",
        assertion: { kind: "equals", field: "mfa_enabled", value: true },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("flagged");
    expect(o.challengeType).toBe("contradicted");
    expect(o.objection).toContain("false");
  });

  test("atLeast → verified when threshold met", () => {
    const b = bundle([{ data: { commits_90d: 42 } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "20+ commits",
        assertion: { kind: "atLeast", field: "commits_90d", value: 20 },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("verified");
  });

  test("atLeast → flagged/overclaim when below threshold", () => {
    const b = bundle([{ data: { uptime_pct: 98.2 } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "99.9% uptime",
        assertion: { kind: "atLeast", field: "uptime_pct", value: 99.9 },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("flagged");
    expect(o.challengeType).toBe("overclaim");
    expect(o.objection).toContain("98.2");
  });

  test("atMost → flagged when value exceeds bound", () => {
    const b = bundle([{ data: { critical_findings: 4 } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "no more than 0 criticals",
        assertion: { kind: "atMost", field: "critical_findings", value: 0 },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("flagged");
  });

  test("matches → verified when regex matches, flagged when not", () => {
    const b = bundle([{ data: { region: "us-central" } }]);
    const ok = strategy.challenge(
      claim({
        id: "1",
        text: "us region",
        assertion: { kind: "matches", field: "region", pattern: "^us-" },
      }),
      ctx(b),
    );
    expect(ok.verdict).toBe("verified");

    const bad = strategy.challenge(
      claim({
        id: "2",
        text: "eu region",
        assertion: { kind: "matches", field: "region", pattern: "^eu-" },
      }),
      ctx(b),
    );
    expect(bad.verdict).toBe("flagged");
  });

  test("freshWithinDays → verified when recent", () => {
    const b = bundle([{ observedAt: daysAgo(5), data: { last_scan: "clean" } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "scanned recently",
        assertion: { kind: "freshWithinDays", field: "last_scan", days: 30 },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("verified");
  });

  test("freshWithinDays → flagged/stale when evidence is old", () => {
    const b = bundle([{ observedAt: daysAgo(120), data: { last_scan: "clean" } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "scanned within 30 days",
        assertion: { kind: "freshWithinDays", field: "last_scan", days: 30 },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("flagged");
    expect(o.challengeType).toBe("stale");
    expect(o.objection).toContain("120");
  });

  test("missing field + self-reported metric → flagged/unsupported", () => {
    const b = bundle([{ data: { commits_90d: 42 } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "over 5000 active users",
        selfReported: true,
        assertion: { kind: "atLeast", field: "active_users", value: 5000 },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("flagged");
    expect(o.challengeType).toBe("unsupported");
  });

  test("missing field + not self-reported → unresolved", () => {
    const b = bundle([{ data: { commits_90d: 42 } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "has a SOC2 report",
        selfReported: false,
        assertion: { kind: "exists", field: "soc2_report" },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("unresolved");
    expect(o.challengeType).toBe("unsupported");
  });

  test("numeric assertion on non-numeric evidence → unresolved (type mismatch)", () => {
    const b = bundle([{ data: { commits_90d: "not-a-number" } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "20+ commits",
        assertion: { kind: "atLeast", field: "commits_90d", value: 20 },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("unresolved");
  });

  test("numeric string evidence is coerced ('42' satisfies atLeast 20)", () => {
    const b = bundle([{ data: { commits_90d: "42" } }]);
    const o = strategy.challenge(
      claim({
        id: "1",
        text: "20+ commits",
        assertion: { kind: "atLeast", field: "commits_90d", value: 20 },
      }),
      ctx(b),
    );
    expect(o.verdict).toBe("verified");
  });
});

describe("RuleBasedChallengeStrategy — heuristics (no assertion)", () => {
  test("self-reported metric claim with no assertion → flagged/unsupported", () => {
    const o = strategy.challenge(
      claim({ id: "1", text: "We have 10000 downloads.", selfReported: true }),
      ctx(bundle([])),
    );
    expect(o.verdict).toBe("flagged");
    expect(o.challengeType).toBe("unsupported");
    expect(o.objection).not.toBeNull();
  });

  test("non-metric self-reported claim with no assertion → unresolved", () => {
    const o = strategy.challenge(
      claim({ id: "1", text: "The project integrates with our IdP.", selfReported: true }),
      ctx(bundle([])),
    );
    expect(o.verdict).toBe("unresolved");
    expect(o.challengeType).toBe("vague");
  });

  test("every non-verified outcome carries a non-null objection", () => {
    const o = strategy.challenge(
      claim({ id: "1", text: "vague statement", selfReported: false }),
      ctx(bundle([])),
    );
    expect(o.verdict).not.toBe("verified");
    expect(o.objection).not.toBeNull();
  });
});
