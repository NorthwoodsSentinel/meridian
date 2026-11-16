/**
 * Edge-path tests for the evidence adapters (audit, cistern loader, local JSON,
 * rhizome membership). Added with the factory coverage gate (>= 90 per file on
 * all four dimensions): each test drives a failure or fallback branch the behavior
 * suites did not reach and asserts what the adapter records on it. No source
 * behavior changed to make these pass.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  EvidenceAuditAdapter,
  buildAuditClaims,
  requirementToAssertion,
} from "../src/evidence/audit.ts";
import type { ControlRequirement, ControlSet, ControlSetSource } from "../src/evidence/audit.ts";
import { cisternMemberLoader } from "../src/evidence/cistern.ts";
import { LocalJsonEvidenceAdapter } from "../src/evidence/localJson.ts";
import { RhizomeMembershipAdapter } from "../src/evidence/rhizome.ts";
import type { MemberSubstrateSource } from "../src/evidence/rhizome.ts";
import { findField } from "../src/challenge/evidenceQuery.ts";
import type { EvidenceBundle } from "../src/types.ts";

function tmpFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "meridian-ev-")), name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** A source object whose `inline` getter throws: the only way an inline source can fail. */
function throwingInline<T>(): T {
  return Object.defineProperty({}, "inline", {
    enumerable: true,
    get() {
      throw new Error("inline getter failed");
    },
  }) as T;
}

const controlSet: ControlSet = {
  systemId: "acme",
  controls: [
    {
      id: "mfa",
      name: "MFA enforced",
      category: "identity",
      field: "mfa_enabled",
      claimed: { kind: "equals", value: true },
      observation: { value: true, observedAt: new Date().toISOString() },
    },
  ],
};

describe("audit adapter edge paths", () => {
  test("an unknown requirement kind throws, and buildAuditClaims degrades it to no assertion", () => {
    const bogus = { kind: "nope" } as unknown as ControlRequirement; // untrusted-input shape
    expect(() => requirementToAssertion("f", bogus)).toThrow("Unhandled control requirement");
    const claims = buildAuditClaims({
      systemId: "acme",
      controls: [
        { id: "a", name: "A", category: "logging", field: "f", claimed: bogus },
        { id: "b", name: "B", category: "logging", field: "g", claimed: bogus, selfReported: true },
      ],
    });
    expect(claims.map((c) => [c.assertion, c.selfReported])).toEqual([
      [undefined, false],
      [undefined, true],
    ]);
  });

  test("a filePath source reads the file, and a bad file is a recorded failure", async () => {
    const good = tmpFile("controls.json", JSON.stringify(controlSet));
    const ok = await new EvidenceAuditAdapter({ filePath: good }).collect({ subjectId: "acme" });
    expect(ok.items).toHaveLength(1);
    const bad = tmpFile("bad.json", "{ not json");
    const failed = await new EvidenceAuditAdapter({ filePath: bad }).collect({ subjectId: "acme" });
    expect(failed.items).toEqual([]);
    expect(failed.failures[0]?.source).toBe(bad);
  });

  test("a loader that throws a non-Error and a failing inline source are labelled", async () => {
    const loader: ControlSetSource = {
      load: () => {
        throw "loader down";
      },
    };
    const fromLoader = await new EvidenceAuditAdapter(loader).collect({ subjectId: "acme" });
    expect(fromLoader.failures).toEqual([
      { source: "evidence-audit:loader", reason: "loader down" },
    ]);
    const fromInline = await new EvidenceAuditAdapter(throwingInline<ControlSetSource>()).collect({
      subjectId: "acme",
    });
    expect(fromInline.failures).toEqual([
      { source: "evidence-audit:inline", reason: "inline getter failed" },
    ]);
  });
});

describe("rhizome adapter edge paths", () => {
  test("a filePath source reads the file and skips unparseable timestamps in rollups", async () => {
    const path = tmpFile(
      "member.json",
      JSON.stringify({
        memberId: "aspen",
        peerAttestations: [
          { voucher: "birch", subject: "aspen", statement: "ok", observedAt: "garbage" },
        ],
        contributionReceipts: [],
        participationLogs: [],
      }),
    );
    const b = await new RhizomeMembershipAdapter({ filePath: path }).collect({
      subjectId: "aspen",
    });
    expect(b.failures).toEqual([]);
    const rollup = b.items.find((i) => i.source === "rhizome:vouch-rollup");
    expect(rollup?.observedAt).toBe(b.collectedAt);
  });

  test("failures carry the right source label for filePath, non-Error loader and inline", async () => {
    const missing = join(tmpdir(), "meridian-definitely-missing.json");
    const fromFile = await new RhizomeMembershipAdapter({ filePath: missing }).collect({
      subjectId: "aspen",
    });
    expect(fromFile.failures[0]?.source).toBe(missing);
    const fromLoader = await new RhizomeMembershipAdapter({
      load: () => {
        throw "loader down";
      },
    }).collect({ subjectId: "aspen" });
    expect(fromLoader.failures).toEqual([{ source: "rhizome:loader", reason: "loader down" }]);
    const fromInline = await new RhizomeMembershipAdapter(
      throwingInline<MemberSubstrateSource>(),
    ).collect({ subjectId: "aspen" });
    expect(fromInline.failures).toEqual([
      { source: "rhizome:inline", reason: "inline getter failed" },
    ]);
  });
});

describe("local JSON adapter edge paths", () => {
  test("a non-Error parse failure, an object without items, and item defaults", async () => {
    const empty = await new LocalJsonEvidenceAdapter({ inline: {} }).collect({ subjectId: "s" });
    expect(empty.items).toEqual([]);
    const filled = await new LocalJsonEvidenceAdapter({
      inline: [{ id: "x", source: "src", kind: "k", observedAt: "2026-01-01T00:00:00.000Z" }],
    }).collect({ subjectId: "s" });
    expect(filled.items[0]).toEqual({
      id: "x",
      source: "src",
      kind: "k",
      observedAt: "2026-01-01T00:00:00.000Z",
      data: {},
    });
    const defaults = await new LocalJsonEvidenceAdapter({ inline: [{}] }).collect({
      subjectId: "s",
    });
    expect(defaults.items[0]?.source).toBe("local-json");
    expect(defaults.items[0]?.kind).toBe("generic");
  });

  test("a file-read error that is not an Error instance is stringified", async () => {
    const original = JSON.parse;
    const path = tmpFile("e.json", "[]");
    JSON.parse = () => {
      throw "not an error object";
    };
    try {
      const b = await new LocalJsonEvidenceAdapter({ filePath: path }).collect({ subjectId: "s" });
      expect(b.failures).toEqual([{ source: path, reason: "not an error object" }]);
    } finally {
      JSON.parse = original;
    }
  });
});

describe("findField", () => {
  test("a second item agreeing with the first is not a conflict", () => {
    const item = (id: string) => ({
      id,
      source: "s",
      kind: "k",
      observedAt: new Date().toISOString(),
      data: { x: 1 },
    });
    const b: EvidenceBundle = {
      subjectId: "s",
      collectedAt: new Date().toISOString(),
      adapterId: "t",
      items: [item("a"), item("b")],
      failures: [],
    };
    expect(findField(b, "x")?.conflict).toBe(false);
  });
});

describe("cistern loader edge paths", () => {
  type Route = (url: URL) => Response;

  function fakeFetch(route: Route): { fetchImpl: typeof fetch; urls: URL[] } {
    const urls: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      urls.push(url);
      return route(url);
    }) as typeof fetch;
    return { fetchImpl, urls };
  }

  const env = (hash: string, occurred: string | null = null) => ({
    content_hash: hash,
    occurred_at: occurred,
    ingested_at: "2026-07-06T00:00:00.000Z",
  });

  test("follows the cursor across pages and stops on an empty page", async () => {
    const pages = [
      { episodes: [env("h1")], nextCursor: "c1" },
      { episodes: [], nextCursor: "c2" },
    ];
    let page = 0;
    const { fetchImpl, urls } = fakeFetch((url) => {
      if (url.pathname === "/episodes") return Response.json(pages[page++]);
      return new Response("not found", { status: 404 });
    });
    const load = cisternMemberLoader({ baseUrl: "https://c.example/", token: "t", fetchImpl });
    const s = await load("aspen");
    expect(s.peerAttestations).toEqual([]);
    const episodeUrls = urls.filter((u) => u.pathname === "/episodes");
    expect(episodeUrls).toHaveLength(2);
    expect(episodeUrls[0]?.searchParams.get("source")).toBe("rhizome");
    expect(episodeUrls[1]?.searchParams.get("since")).toBe("c1");
  });

  test("a failing /episodes or /raw status throws; non-JSON and non-object raw are skipped", async () => {
    const down = fakeFetch(() => new Response("", { status: 503 }));
    await expect(
      cisternMemberLoader({ baseUrl: "https://c", token: "t", fetchImpl: down.fetchImpl })("a"),
    ).rejects.toThrow("cistern GET /episodes 503");

    const rawDown = fakeFetch((url) =>
      url.pathname === "/episodes"
        ? Response.json({ episodes: [env("h1")], nextCursor: null })
        : new Response("", { status: 500 }),
    );
    await expect(
      cisternMemberLoader({ baseUrl: "https://c", token: "t", fetchImpl: rawDown.fetchImpl })("a"),
    ).rejects.toThrow("cistern GET /raw 500 for h1");

    const odd = fakeFetch((url) => {
      if (url.pathname === "/episodes")
        return Response.json({ episodes: [env("h1"), env("h2")], nextCursor: null });
      return new Response(url.pathname.endsWith("h1") ? "not json" : "42", { status: 200 });
    });
    const s = await cisternMemberLoader({
      baseUrl: "https://c",
      token: "t",
      fetchImpl: odd.fetchImpl,
    })("a");
    expect(s).toEqual({
      memberId: "a",
      peerAttestations: [],
      contributionReceipts: [],
      participationLogs: [],
    });
  });

  test("timestamp fallbacks, missing optional fields, and entries missing their key field", async () => {
    const raws: Record<string, unknown> = {
      v1: { subject: "a", kind: "vouch", voucher: "birch" },
      v2: { subject: "a", kind: "vouch" },
      c1: { subject: "a", kind: "contribution", receiptHash: "rh" },
      c2: { subject: "a", kind: "contribution" },
      p1: { subject: "a", kind: "participation" },
      p2: { subject: "a", kind: "participation", activity: "meeting", observedAt: "2026-07-01" },
      x1: { subject: "a", kind: "unknown-kind", activity: "ignored" },
    };
    const { fetchImpl } = fakeFetch((url) => {
      if (url.pathname === "/episodes")
        return Response.json({
          episodes: [
            env("v1", "2026-07-02T00:00:00.000Z"),
            env("v2"),
            env("c1"),
            env("c2"),
            env("p1"),
            env("p2"),
            env("x1"),
          ],
          nextCursor: null,
        });
      return Response.json(raws[url.pathname.slice("/raw/".length)]);
    });
    const s = await cisternMemberLoader({ baseUrl: "https://c", token: "t", fetchImpl })("a");
    expect(s.peerAttestations).toEqual([
      { voucher: "birch", subject: "a", statement: "", observedAt: "2026-07-02T00:00:00.000Z" },
    ]);
    expect(s.contributionReceipts).toEqual([
      { what: "", receiptHash: "rh", observedAt: "2026-07-06T00:00:00.000Z" },
    ]);
    expect(s.participationLogs).toEqual([{ activity: "meeting", observedAt: "2026-07-01" }]);
  });
});

describe("cistern loader default fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("uses the global fetch when no fetchImpl is given", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(input);
      return Response.json({ episodes: [], nextCursor: null });
    });
    const s = await cisternMemberLoader({ baseUrl: "https://c", token: "t" })("a");
    expect(s.peerAttestations).toEqual([]);
    expect(calls).toEqual(["https://c/episodes?source=rhizome&limit=200"]);
  });
});
