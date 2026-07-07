/**
 * Evidence lookup helpers used by the rule-based challenge strategy.
 *
 * Assertions reference a `field` by dot-path (e.g. "activity.commits_90d").
 * We search every evidence item's `data` for that path and return the first
 * hit together with the item it came from (so the strategy can reason about
 * staleness via `item.observedAt`).
 */
import type { EvidenceBundle, EvidenceItem } from "../types.ts";

export type FieldHit = {
  value: unknown;
  item: EvidenceItem;
  /**
   * True when more than one evidence item defines this field with a DIFFERENT
   * value. First-match-wins would let an attacker hide a failing observation
   * behind a passing sibling that shares the field name; the strategy must
   * treat a conflict as unverifiable rather than silently taking the first.
   */
  conflict: boolean;
};

/** Resolve a dot-path against a nested object. Returns undefined if any hop misses. */
export function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Find a field across all evidence items. Returns the first item that has the
 * path defined (value !== undefined), and flags `conflict` when a later item
 * defines the same field with a different value. Callers still control which
 * value is cited by ordering, but can no longer hide a disagreement: a conflict
 * is surfaced so the verdict reflects it instead of silently taking the first.
 */
export function findField(bundle: EvidenceBundle, field: string): FieldHit | undefined {
  let first: { value: unknown; item: EvidenceItem } | undefined;
  let conflict = false;
  for (const item of bundle.items) {
    const value = getPath(item.data, field);
    if (value === undefined) continue;
    if (first === undefined) {
      first = { value, item };
    } else if (!sameValue(value, first.value)) {
      conflict = true;
    }
  }
  if (first === undefined) return undefined;
  return { value: first.value, item: first.item, conflict };
}

/** Structural equality over JSON-shaped evidence values (canonical stringify). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whole-number days between an ISO timestamp and now (negative if in the future). */
export function ageInDays(observedAt: string, now: number = Date.now()): number {
  const then = new Date(observedAt).getTime();
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}
