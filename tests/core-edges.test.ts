/**
 * Edge-path tests for the core modules (log, store, signing, verify, engine,
 * evidence query, rule-based strategy, value routing). Added with the factory
 * coverage gate (>= 90 per file on all four dimensions): each test drives a
 * branch the behavior suites did not reach and asserts what the code does on it.
 * No source behavior changed to make these pass.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ExecutionLog } from "../src/log.ts";
import { JsonFileReceiptStore } from "../src/store/jsonFileStore.ts";
import { Ed25519Signer, verifySignature } from "../src/signing.ts";
import { verifyResult } from "../src/verify.ts";
import { MeridianEngine } from "../src/engine.ts";
import { RuleBasedChallengeStrategy } from "../src/challenge/ruleBased.ts";
import type { ChallengeContext, ChallengeStrategy } from "../src/challenge/strategy.ts";
import type { ReceiptStore } from "../src/store/receiptStore.ts";
import { ageInDays, getPath } from "../src/challenge/evidenceQuery.ts";
import { additiveValue, distributePayout, quorumGatedValue } from "../src/value/coop.ts";
import { MAX_EXACT_PLAYERS, shapleyValues } from "../src/value/shapley.ts";
import type {
  Assertion,
  Claim,
  ChallengeOutcome,
  EvidenceBundle,
  ExecutionLogEntry,
} from "../src/types.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function bundle(data: Record<string, unknown>, observedAt = new Date().toISOString()) {
  const b: EvidenceBundle = {
    subjectId: "subject",
    collectedAt: new Date().toISOString(),
    adapterId: "test",
    items: [{ id: "e1", source: "feed", kind: "metrics", observedAt, data }],
    failures: [],
  };
  return b;
}

function ctx(b: EvidenceBundle): ChallengeContext {
  return { bundle: b, tools: {}, log: new ExecutionLog() };
}

describe("ExecutionLog", () => {
  test("echo mirrors each level to the matching console method", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new ExecutionLog({ echo: true });
    log.log("error", "challenge", "boom", { a: 1 });
    log.log("error", "challenge", "bare");
    log.log("warn", "collect", "careful");
    log.log("info", "score", "fine");
    expect(err).toHaveBeenCalledWith("[meridian][challenge]", "boom", { a: 1 });
    expect(err).toHaveBeenCalledWith("[meridian][challenge]", "bare", "");
    expect(warn).toHaveBeenCalledWith("[meridian][collect]", "careful", "");
    expect(info).toHaveBeenCalledWith("[meridian][score]", "fine", "");
  });

  test("an entry without details has no details key, and entries() is a copy", () => {
    const seen: ExecutionLogEntry[] = [];
    const log = new ExecutionLog({ onEntry: (e) => seen.push(e) });
    log.log("info", "collect", "bare");
    expect(seen).toHaveLength(1);
    expect("details" in seen[0]!).toBe(false);
    const snap = log.entries();
    snap.pop();
    expect(log.entries()).toHaveLength(1);
  });
});

describe("JsonFileReceiptStore", () => {
  test("load returns null for an unknown run and the saved result for a known one", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "meridian-store-")), "nested");
    const store = new JsonFileReceiptStore(dir);
    expect(await store.load("missing")).toBeNull();
    const result = await new MeridianEngine({
      strategy: new RuleBasedChallengeStrategy(),
      signer: Ed25519Signer.generate(),
    }).verify({ subject: "s", claims: [], evidence: bundle({}) });
    const path = await store.save(result);
    expect(path).toBe(join(dir, `${result.runId}.json`));
    expect((await store.load(result.runId))?.runId).toBe(result.runId);
  });
});

describe("verifySignature", () => {
  const signer = Ed25519Signer.generate();

  test("rejects a non-ed25519 algorithm", () => {
    const sig = signer.sign("m");
    expect(verifySignature({ ...sig, algorithm: "rsa" as "ed25519" }, "m")).toBe(false);
  });

  test("returns false, not a throw, when the embedded public key is unparseable", () => {
    const sig = signer.sign("m");
    expect(verifySignature({ ...sig, publicKey: "bm90IGEga2V5" }, "m")).toBe(false);
  });
});

describe("verifyResult", () => {
  test("an objection whose claim has no outcome fails its signature check", async () => {
    const strategy: ChallengeStrategy = {
      id: "always-flag",
      challenge: (claim) => ({
        claimId: claim.id,
        claimText: claim.text,
        verdict: "flagged",
        challengeType: "contradicted",
        challengeEvidence: "e",
        objection: "o",
        confidence: 0.2,
      }),
    };
    const result = await new MeridianEngine({
      strategy,
      signer: Ed25519Signer.generate(),
    }).verify({
      subject: "s",
      claims: [{ id: "c1", text: "t", selfReported: false }],
      evidence: bundle({}),
    });
    const orphaned = {
      ...result,
      signedObjections: result.signedObjections.map((o) => ({ ...o, claimId: "ghost" })),
    };
    const v = verifyResult(orphaned);
    expect(v.objectionsValid).toBe(false);
    expect(v.objectionResults).toEqual([{ claimId: "ghost", valid: false }]);
  });
});

describe("MeridianEngine edge paths", () => {
  const claim: Claim = { id: "c1", text: "a claim", selfReported: false };

  test("a strategy that throws a non-Error still yields a cited unresolved outcome", async () => {
    const strategy: ChallengeStrategy = {
      id: "throws-string",
      challenge: () => {
        throw "plain string failure";
      },
    };
    const result = await new MeridianEngine({
      strategy,
      signer: Ed25519Signer.generate(),
    }).verify({ subject: "s", claims: [claim], evidence: bundle({}) });
    expect(result.outcomes[0]?.verdict).toBe("unresolved");
    expect(result.outcomes[0]?.challengeEvidence).toContain("plain string failure");
  });

  test("a non-verified outcome with a null objection gets the default objection text", async () => {
    const strategy: ChallengeStrategy = {
      id: "null-objection",
      challenge: (c): ChallengeOutcome => ({
        claimId: c.id,
        claimText: c.text,
        verdict: "flagged",
        challengeType: "contradicted",
        challengeEvidence: "e",
        objection: null,
        confidence: 0.1,
      }),
    };
    const result = await new MeridianEngine({
      strategy,
      signer: Ed25519Signer.generate(),
    }).verify({ subject: "s", claims: [claim], evidence: bundle({}) });
    expect(result.signedObjections[0]?.objection).toBe("Flagged — see challenge evidence.");
    expect(verifyResult(result).objectionsValid).toBe(true);
  });

  test("a store failure is logged and non-fatal, for Error and non-Error throws", async () => {
    for (const thrown of [new Error("disk full"), "quota"]) {
      const store: ReceiptStore = {
        save: () => Promise.reject(thrown),
        load: () => Promise.resolve(null),
      };
      const entries: ExecutionLogEntry[] = [];
      const result = await new MeridianEngine({
        strategy: new RuleBasedChallengeStrategy(),
        signer: Ed25519Signer.generate(),
        store,
        onLog: (e) => entries.push(e),
      }).verify({ subject: "s", claims: [claim], evidence: bundle({}) });
      const failed = entries.find((e) => e.action === "result:store-failed");
      expect(failed?.details).toEqual({ reason: thrown instanceof Error ? "disk full" : "quota" });
      expect(result.executionLog.some((e) => e.action === "run:done")).toBe(true);
    }
  });
});

describe("evidence query helpers", () => {
  test("getPath stops at a non-object hop", () => {
    expect(getPath({ a: 5 }, "a.b")).toBeUndefined();
    expect(getPath({ a: null }, "a.b")).toBeUndefined();
  });

  test("ageInDays treats an unparseable timestamp as infinitely old", () => {
    expect(ageInDays("not a date")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("RuleBasedChallengeStrategy edge paths", () => {
  const strategy = new RuleBasedChallengeStrategy();
  const run = (assertion: Assertion, data: Record<string, unknown>) =>
    strategy.challenge(
      { id: "c", text: "claim", selfReported: false, assertion },
      ctx(bundle(data)),
    );

  test("atMost on a non-numeric value is a type mismatch, and within bound verifies", () => {
    expect(run({ kind: "atMost", field: "x", value: 5 }, { x: "many" }).verdict).toBe("unresolved");
    expect(run({ kind: "atMost", field: "x", value: 5 }, { x: 3 }).verdict).toBe("verified");
  });

  test("matches on a non-string value is a type mismatch", () => {
    expect(run({ kind: "matches", field: "x", pattern: "a" }, { x: 7 }).verdict).toBe("unresolved");
  });

  test("an invalid regular expression resolves as unresolved, not a throw", () => {
    const out = run({ kind: "matches", field: "x", pattern: "(" }, { x: "abc" });
    expect(out.verdict).toBe("unresolved");
    expect(out.challengeEvidence).toContain("not a valid regular expression");
  });

  test("an over-long value is truncated before matching", () => {
    const long = "a".repeat(20000) + "TAIL";
    expect(run({ kind: "matches", field: "x", pattern: "TAIL" }, { x: long }).verdict).toBe(
      "flagged",
    );
    expect(run({ kind: "matches", field: "x", pattern: "^a" }, { x: long }).verdict).toBe(
      "verified",
    );
  });

  test("an unknown assertion kind from untrusted input throws", () => {
    const bogus = { kind: "nope", field: "x" } as unknown as Assertion; // untrusted-input shape
    expect(() => run(bogus, { x: 1 })).toThrow("Unhandled assertion kind");
  });
});

describe("value routing edge paths", () => {
  test("all-zero weights pay nothing rather than dividing by zero", () => {
    const shares = distributePayout(100, [
      { memberId: "a", weight: 0 },
      { memberId: "b", weight: 0 },
    ]);
    expect(shares.map((s) => s.share)).toEqual([0, 0]);
  });

  test("the default value function is additive", () => {
    const explicit = distributePayout(10, [{ memberId: "a", weight: 2 }], additiveValue);
    const implicit = distributePayout(10, [{ memberId: "a", weight: 2 }]);
    expect(implicit).toEqual(explicit);
    expect(quorumGatedValue(2)(() => 1, ["a"])).toBe(0);
  });

  test("shapleyValues handles zero players and refuses too many", () => {
    expect(shapleyValues([], () => 0)).toEqual({});
    const many = Array.from({ length: MAX_EXACT_PLAYERS + 1 }, (_, i) => `p${i}`);
    expect(() => shapleyValues(many, () => 0)).toThrow(`limited to ${MAX_EXACT_PLAYERS}`);
  });
});

describe("value routing weight lookup", () => {
  test("a value function asking about a non-contributor sees weight 0", () => {
    const asked: number[] = [];
    distributePayout(1, [{ memberId: "a", weight: 3 }], (weightOf, coalition) => {
      asked.push(weightOf("stranger"));
      return coalition.length;
    });
    expect(asked.every((w) => w === 0)).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
  });
});
