import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalJsonEvidenceAdapter } from "../src/evidence/localJson.ts";

describe("LocalJsonEvidenceAdapter", () => {
  test("reads inline object form and fills defaults", async () => {
    const adapter = new LocalJsonEvidenceAdapter({
      inline: { items: [{ kind: "control-config", data: { mfa_enabled: false } }] },
    });
    const b = await adapter.collect({ subjectId: "s1" });
    expect(b.subjectId).toBe("s1");
    expect(b.adapterId).toBe("local-json");
    expect(b.items).toHaveLength(1);
    const item = b.items[0]!;
    expect(item.kind).toBe("control-config");
    expect(item.id).toBeString();
    expect(item.source).toBe("local-json");
    expect(item.observedAt).toBeString();
    expect(item.data).toEqual({ mfa_enabled: false });
  });

  test("reads bare-array form", async () => {
    const adapter = new LocalJsonEvidenceAdapter({
      inline: [{ kind: "a", data: { x: 1 } }, { kind: "b", data: { y: 2 } }],
    });
    const b = await adapter.collect({ subjectId: "s2" });
    expect(b.items).toHaveLength(2);
    expect(b.failures).toHaveLength(0);
  });

  test("propagates declared failures from object form", async () => {
    const adapter = new LocalJsonEvidenceAdapter({
      inline: { items: [], failures: [{ source: "api", reason: "timeout" }] },
    });
    const b = await adapter.collect({ subjectId: "s3" });
    expect(b.failures).toEqual([{ source: "api", reason: "timeout" }]);
  });

  test("reads from a file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-ev-"));
    const path = join(dir, "ev.json");
    writeFileSync(path, JSON.stringify([{ kind: "k", data: { a: 1 } }]));
    const b = await new LocalJsonEvidenceAdapter({ filePath: path }).collect({ subjectId: "s4" });
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.data).toEqual({ a: 1 });
  });

  test("missing file becomes a recorded failure, not a crash", async () => {
    const adapter = new LocalJsonEvidenceAdapter({ filePath: "/nonexistent/path/ev.json" });
    const b = await adapter.collect({ subjectId: "s5" });
    expect(b.items).toHaveLength(0);
    expect(b.failures).toHaveLength(1);
    expect(b.failures[0]!.source).toContain("ev.json");
  });
});
