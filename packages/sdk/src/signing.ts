import nacl from 'tweetnacl';
import stringify from 'json-stable-stringify';
import { createHash } from 'node:crypto';
import { OphirError, OphirErrorCode } from '@ophir/protocol';
import type { FinalTerms } from '@ophir/protocol';

/**
 * JCS (RFC 8785) canonicalization using json-stable-stringify.
 * Produces deterministic JSON output regardless of key insertion order.
 * Handles nested objects, arrays, nulls, numbers, and booleans.
 * Undefined values are excluded (standard JSON.stringify behavior).
 *
 * @param obj - The value to canonicalize. Must be a JSON-serializable value
 *   (object, array, string, number, boolean, or null). Throws on undefined,
 *   functions, or symbols.
 * @returns A deterministic JSON string with sorted keys.
 * @throws {OphirError} INVALID_MESSAGE if the input cannot be serialized
 *   (undefined, function, symbol, or circular reference).
 *
 * @example
 * ```typescript
 * const canonical = canonicalize({ z: 1, a: 2 });
 * // '{"a":2,"z":1}'
 * ```
 */
export function canonicalize(obj: unknown): string {
  if (obj === undefined) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'Cannot canonicalize undefined — value must be JSON-serializable',
    );
  }
  if (typeof obj === 'function' || typeof obj === 'symbol') {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      `Cannot canonicalize ${typeof obj} — value must be JSON-serializable`,
    );
  }
  const result = stringify(obj);
  if (result === undefined) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'Canonicalization failed — input may contain circular references',
    );
  }
  return result;
}

/**
 * Ed25519 sign canonical bytes. Returns base64-encoded signature.
 *
 * @param canonicalBytes - The data to sign as a Uint8Array.
 * @param secretKey - The 64-byte Ed25519 secret key.
 * @throws {OphirError} if canonicalBytes is not a Uint8Array.
 * @throws {OphirError} if secretKey is not 64 bytes.
 *
 * @example
 * ```typescript
 * const data = new TextEncoder().encode('hello ophir');
 * const signature = sign(data, keypair.secretKey);
 * ```
 */
export function sign(canonicalBytes: Uint8Array, secretKey: Uint8Array): string {
  if (!(canonicalBytes instanceof Uint8Array)) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'canonicalBytes must be a Uint8Array',
    );
  }
  if (secretKey.length !== nacl.sign.secretKeyLength) {
    throw new OphirError(
      OphirErrorCode.INVALID_SIGNATURE,
      `Invalid secret key length: expected ${nacl.sign.secretKeyLength}, got ${secretKey.length}`,
    );
  }
  const sig = nacl.sign.detached(canonicalBytes, secretKey);
  return Buffer.from(sig).toString('base64');
}

/**
 * Verify base64-encoded Ed25519 signature against public key.
 * Returns false (never throws) on any invalid input.
 *
 * @param canonicalBytes - The data that was signed as a Uint8Array.
 * @param signature - The base64-encoded signature string.
 * @param publicKey - The 32-byte Ed25519 public key.
 * @throws never
 *
 * @example
 * ```typescript
 * const data = new TextEncoder().encode('hello ophir');
 * const valid = verify(data, signature, keypair.publicKey);
 * // true or false
 * ```
 */
export function verify(
  canonicalBytes: Uint8Array,
  signature: string,
  publicKey: Uint8Array,
): boolean {
  try {
    if (!(canonicalBytes instanceof Uint8Array)) {
      return false;
    }
    if (publicKey.length !== nacl.sign.publicKeyLength) {
      return false;
    }
    const sigBytes = Buffer.from(signature, 'base64');
    if (sigBytes.length !== nacl.sign.signatureLength) {
      return false;
    }
    return nacl.sign.detached.verify(canonicalBytes, sigBytes, publicKey);
  } catch {
    return false;
  }
}

/**
 * SHA-256 hash of canonicalized final terms, returned as hex string.
 * Used as the agreement_hash that both parties commit to.
 *
 * Validates that finalTerms contains the required fields: price_per_unit, currency, and unit.
 *
 * @throws {OphirError} if finalTerms is missing required fields.
 *
 * @example
 * ```typescript
 * const hash = agreementHash({ price_per_unit: '0.01', currency: 'USDC', unit: 'request' });
 * // '3a7f...' (64-char hex string)
 * ```
 */
export function agreementHash(finalTerms: FinalTerms): string {
  if (!finalTerms || typeof finalTerms !== 'object') {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'finalTerms must be a non-null object',
    );
  }
  if (!finalTerms.price_per_unit || !finalTerms.currency || !finalTerms.unit) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'finalTerms must contain price_per_unit, currency, and unit',
    );
  }
  const canonical = canonicalize(finalTerms);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Canonicalize params object, sign with Ed25519, return base64 signature.
 *
 * @param params - The object to canonicalize and sign. Must not be null or undefined.
 * @param secretKey - The 64-byte Ed25519 secret key.
 * @throws {OphirError} if params is null or undefined.
 * @throws {OphirError} if secretKey is not 64 bytes.
 *
 * @example
 * ```typescript
 * const sig = signMessage({ rfq_id: 'rfq-001', price: '10.00' }, keypair.secretKey);
 * ```
 */
export function signMessage(params: unknown, secretKey: Uint8Array): string {
  if (params === null || params === undefined) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'params must not be null or undefined',
    );
  }
  const canonical = canonicalize(params);
  const bytes = new TextEncoder().encode(canonical);
  return sign(bytes, secretKey);
}

/**
 * Canonicalize params object, verify Ed25519 signature.
 * Returns false (never throws) on invalid signature or null/undefined params.
 *
 * @param params - The object that was signed.
 * @param signature - The base64-encoded signature string.
 * @param publicKey - The 32-byte Ed25519 public key.
 * @throws never
 *
 * @example
 * ```typescript
 * const valid = verifyMessage({ rfq_id: 'rfq-001', price: '10.00' }, sig, keypair.publicKey);
 * // true or false
 * ```
 */
export function verifyMessage(
  params: unknown,
  signature: string,
  publicKey: Uint8Array,
): boolean {
  if (!signature || typeof signature !== 'string') {
    return false;
  }
  if (params === null || params === undefined) {
    return false;
  }
  const canonical = canonicalize(params);
  const bytes = new TextEncoder().encode(canonical);
  return verify(bytes, signature, publicKey);
}
