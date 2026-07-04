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
 * path defined (value !== undefined). Order follows bundle item order, so
 * callers control precedence by ordering their evidence.
 */
export function findField(bundle: EvidenceBundle, field: string): FieldHit | undefined {
  for (const item of bundle.items) {
    const value = getPath(item.data, field);
    if (value !== undefined) return { value, item };
  }
  return undefined;
}

/** Whole-number days between an ISO timestamp and now (negative if in the future). */
export function ageInDays(observedAt: string, now: number = Date.now()): number {
  const then = new Date(observedAt).getTime();
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}
