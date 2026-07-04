/**
 * Local ed25519 signing — the drop-in replacement for kredence's EIP-191 wallet
 * signing (`adversarial/sign.ts`, viem + baseSepolia). No wallets, no chain, no
 * RPC. Keys are plain node:crypto ed25519 keypairs, optionally persisted to disk
 * as PEM so a run can reuse a stable signer identity.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Signature } from "./types.ts";

/**
 * Canonical JSON: object keys sorted recursively so the same logical value
 * always serializes to the same bytes. Both signer and verifier must agree on
 * this, exactly as kredence's `buildCanonicalMessage` did.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

/** A thing that can produce detached ed25519 signatures. */
export interface Signer {
  readonly algorithm: "ed25519";
  /** Base64 SPKI DER of the public key. */
  readonly publicKeyBase64: string;
  sign(message: string): Signature;
}

export class Ed25519Signer implements Signer {
  readonly algorithm = "ed25519" as const;
  readonly publicKeyBase64: string;
  #privateKey: KeyObject;
  #publicKey: KeyObject;

  private constructor(privateKey: KeyObject, publicKey: KeyObject) {
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
    this.publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  }

  /** Generate a fresh ephemeral keypair (new identity every call). */
  static generate(): Ed25519Signer {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return new Ed25519Signer(privateKey, publicKey);
  }

  /** Construct from an existing PEM private key. */
  static fromPrivateKeyPem(pem: string): Ed25519Signer {
    const privateKey = createPrivateKey(pem);
    // node's createPublicKey extracts the public half from a private-key PEM.
    const publicKey = createPublicKey(pem);
    return new Ed25519Signer(privateKey, publicKey);
  }

  /**
   * Load a signer from `<dir>/signer.key` (PEM), creating and persisting a new
   * keypair on first use. Gives a run a stable, portable signer identity without
   * any secret manager — the local-storage analogue of kredence's OPERATOR key.
   */
  static loadOrCreate(dir: string): Ed25519Signer {
    const keyPath = join(dir, "signer.key");
    if (existsSync(keyPath)) {
      return Ed25519Signer.fromPrivateKeyPem(readFileSync(keyPath, "utf8"));
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, pem, { mode: 0o600 });
    return new Ed25519Signer(privateKey, publicKey);
  }

  sign(message: string): Signature {
    const signature = cryptoSign(null, Buffer.from(message, "utf8"), this.#privateKey);
    return {
      algorithm: "ed25519",
      publicKey: this.publicKeyBase64,
      messageHash: sha256Hex(message),
      signature: signature.toString("base64"),
    };
  }
}

/**
 * Verify a signature against the original message. Re-derives the public key
 * from the signature's embedded SPKI, so a holder of just `{ signature, message }`
 * can confirm authenticity offline. Also checks the message hash matches.
 */
export function verifySignature(signature: Signature, message: string): boolean {
  if (signature.algorithm !== "ed25519") return false;
  if (sha256Hex(message) !== signature.messageHash) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(signature.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      null,
      Buffer.from(message, "utf8"),
      publicKey,
      Buffer.from(signature.signature, "base64"),
    );
  } catch {
    return false;
  }
}
