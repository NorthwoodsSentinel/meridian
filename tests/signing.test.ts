import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalize,
  Ed25519Signer,
  sha256Hex,
  verifySignature,
} from "../src/signing.ts";

describe("canonicalize", () => {
  test("is stable regardless of key insertion order", () => {
    const a = canonicalize({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = canonicalize({ nested: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  test("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("sha256Hex", () => {
  test("is deterministic", () => {
    expect(sha256Hex("meridian")).toBe(sha256Hex("meridian"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("Ed25519Signer", () => {
  test("sign → verify roundtrip succeeds", () => {
    const signer = Ed25519Signer.generate();
    const message = canonicalize({ claim: "x", verdict: "flagged" });
    const sig = signer.sign(message);
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.messageHash).toBe(sha256Hex(message));
    expect(verifySignature(sig, message)).toBe(true);
  });

  test("verification fails when the message is tampered", () => {
    const signer = Ed25519Signer.generate();
    const sig = signer.sign("original");
    expect(verifySignature(sig, "tampered")).toBe(false);
  });

  test("verification fails when the signature bytes are tampered", () => {
    const signer = Ed25519Signer.generate();
    const sig = signer.sign("original");
    const flipped = { ...sig, signature: Buffer.from("not-the-signature").toString("base64") };
    expect(verifySignature(flipped, "original")).toBe(false);
  });

  test("verification fails when the message hash is inconsistent", () => {
    const signer = Ed25519Signer.generate();
    const sig = signer.sign("original");
    const badHash = { ...sig, messageHash: "0".repeat(64) };
    expect(verifySignature(badHash, "original")).toBe(false);
  });

  test("loadOrCreate persists the key and reloads the same identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-keys-"));
    const first = Ed25519Signer.loadOrCreate(dir);
    const keyFile = readFileSync(join(dir, "signer.key"), "utf8");
    expect(keyFile).toContain("PRIVATE KEY");

    const second = Ed25519Signer.loadOrCreate(dir);
    expect(second.publicKeyBase64).toBe(first.publicKeyBase64);

    // A signature from the reloaded signer verifies under the original public key.
    const sig = second.sign("hello");
    expect(sig.publicKey).toBe(first.publicKeyBase64);
    expect(verifySignature(sig, "hello")).toBe(true);
  });

  test("two generated signers have distinct public keys", () => {
    expect(Ed25519Signer.generate().publicKeyBase64).not.toBe(
      Ed25519Signer.generate().publicKeyBase64,
    );
  });
});
