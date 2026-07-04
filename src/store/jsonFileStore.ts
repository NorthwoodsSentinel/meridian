/**
 * JsonFileReceiptStore — the concrete local-JSON receipt store. Writes each
 * result to `<dir>/<runId>.json`. Deterministic, offline, and human-readable so
 * a reviewer can open the receipt directly.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VerificationResult } from "../types.ts";
import type { ReceiptStore } from "./receiptStore.ts";

export class JsonFileReceiptStore implements ReceiptStore {
  #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async save(result: VerificationResult): Promise<string> {
    mkdirSync(this.#dir, { recursive: true });
    const path = join(this.#dir, `${result.runId}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2), "utf8");
    return path;
  }

  async load(runId: string): Promise<VerificationResult | null> {
    const path = join(this.#dir, `${runId}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as VerificationResult;
  }
}
