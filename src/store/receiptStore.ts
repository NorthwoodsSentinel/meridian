/**
 * ReceiptStore — pluggable local persistence for verification results and the
 * signed objections. This is the drop-in replacement for kredence's Storacha /
 * IPFS uploads (`uploadJSON` → CID). No chain, no remote pinning: a result is
 * persisted locally and addressed by its runId.
 */
import type { VerificationResult } from "../types.ts";

export interface ReceiptStore {
  /** Persist a full result. Returns an opaque local reference (e.g. a file path). */
  save(result: VerificationResult): Promise<string>;
  /** Load a previously persisted result by runId, or null if absent. */
  load(runId: string): Promise<VerificationResult | null>;
}
