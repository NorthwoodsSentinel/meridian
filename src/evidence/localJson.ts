/**
 * LocalJsonEvidenceAdapter — the one concrete stub adapter shipped for the demo
 * and tests. Reads evidence items from a local JSON file (or an in-memory object)
 * and normalizes them into an EvidenceBundle. No network, fully hermetic.
 *
 * Accepted JSON shapes (both supported so fixtures stay simple):
 *   1. A bare array of raw items:   [ { kind, data, ... }, ... ]
 *   2. An object:                   { items: [ ... ], failures?: [ ... ] }
 *
 * Each raw item may omit `id`/`source`/`observedAt`; sensible defaults are filled.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { EvidenceBundle, EvidenceItem } from "../types.ts";
import type { EvidenceAdapter, EvidenceQuery } from "./adapter.ts";

type RawItem = {
  id?: string;
  source?: string;
  kind?: string;
  observedAt?: string;
  data?: Record<string, unknown>;
};

type RawFile =
  | RawItem[]
  | { items?: RawItem[]; failures?: Array<{ source: string; reason: string }> };

export type LocalJsonSource =
  | { filePath: string }
  | { inline: RawFile };

export class LocalJsonEvidenceAdapter implements EvidenceAdapter {
  readonly id = "local-json";
  #source: LocalJsonSource;

  constructor(source: LocalJsonSource) {
    this.#source = source;
  }

  async collect(query: EvidenceQuery): Promise<EvidenceBundle> {
    const failures: EvidenceBundle["failures"] = [];
    let raw: RawFile;

    if ("filePath" in this.#source) {
      try {
        raw = JSON.parse(readFileSync(this.#source.filePath, "utf8")) as RawFile;
      } catch (err) {
        // A missing/corrupt fixture is a recorded failure, not a thrown crash —
        // the engine can still run and every claim becomes unresolved/unsupported.
        return {
          subjectId: query.subjectId,
          collectedAt: new Date().toISOString(),
          adapterId: this.id,
          items: [],
          failures: [
            {
              source: this.#source.filePath,
              reason: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    } else {
      raw = this.#source.inline;
    }

    const rawItems = Array.isArray(raw) ? raw : (raw.items ?? []);
    if (!Array.isArray(raw) && raw.failures) failures.push(...raw.failures);

    const items: EvidenceItem[] = rawItems.map((item) => ({
      id: item.id ?? randomUUID(),
      source: item.source ?? this.id,
      kind: item.kind ?? "generic",
      observedAt: item.observedAt ?? new Date().toISOString(),
      data: item.data ?? {},
    }));

    return {
      subjectId: query.subjectId,
      collectedAt: new Date().toISOString(),
      adapterId: this.id,
      items,
      failures,
    };
  }
}
