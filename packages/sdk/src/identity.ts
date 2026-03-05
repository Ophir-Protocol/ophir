import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { OphirError, OphirErrorCode } from '@ophirai/protocol';

/** Multicodec prefix for Ed25519 public key (varint-encoded 0xed) */
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

const DID_KEY_PREFIX = 'did:key:z';

/**
 * Generate an Ed25519 keypair for agent identity.
 *
 * @throws {OphirError} if the generated keypair has unexpected key lengths.
 *
 * @example
 * ```typescript
 * const { publicKey, secretKey } = generateKeyPair();
 * // publicKey: Uint8Array(32), secretKey: Uint8Array(64)
 * ```
 */
export function generateKeyPair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const kp = nacl.sign.keyPair();
  if (kp.publicKey.length !== 32 || kp.secretKey.length !== 64) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      `Key generation produced invalid lengths: publicKey=${kp.publicKey.length}, secretKey=${kp.secretKey.length}`,
    );
  }
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * Convert Ed25519 public key to did:key:z6Mk... format.
 * Prepends multicodec prefix (0xed01) then base58-btc encodes with 'z' prefix.
 *
 * @throws {OphirError} if publicKey is not exactly 32 bytes.
 *
 * @example
 * ```typescript
 * const did = publicKeyToDid(keypair.publicKey);
 * // 'did:key:z6Mk...'
 * ```
 */
export function publicKeyToDid(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      `Invalid public key length: expected 32, got ${publicKey.length}`,
    );
  }
  const prefixed = new Uint8Array(
    ED25519_MULTICODEC_PREFIX.length + publicKey.length,
  );
  prefixed.set(ED25519_MULTICODEC_PREFIX);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:z${bs58.encode(prefixed)}`;
}

/**
 * Extract Ed25519 public key from did:key string.
 *
 * @throws {OphirError} if input is empty, DID format is invalid, or extracted key is not 32 bytes.
 *
 * @example
 * ```typescript
 * const publicKey = didToPublicKey('did:key:z6Mk...');
 * // Uint8Array(32)
 * ```
 */
export function didToPublicKey(did: string): Uint8Array {
  if (!did || typeof did !== 'string') {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'DID must be a non-empty string',
    );
  }
  if (!did.startsWith(DID_KEY_PREFIX)) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      `Invalid did:key format: ${did}. Expected format: did:key:z<base58-encoded-ed25519-public-key>`,
    );
  }
  const encoded = did.slice(DID_KEY_PREFIX.length);
  const decoded = bs58.decode(encoded);
  // Strip the 2-byte multicodec prefix
  if (
    decoded.length < 2 ||
    decoded[0] !== ED25519_MULTICODEC_PREFIX[0] ||
    decoded[1] !== ED25519_MULTICODEC_PREFIX[1]
  ) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'Invalid multicodec prefix — expected Ed25519 (0xed01)',
    );
  }
  const publicKey = decoded.slice(2);
  if (publicKey.length !== 32) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      `Invalid public key length after DID decoding: expected 32, got ${publicKey.length}`,
    );
  }
  return publicKey;
}

/**
 * Generate a complete agent identity bundle.
 *
 * @param endpoint - The HTTPS endpoint URL for the agent.
 * @throws {OphirError} if endpoint is not a valid URL with http or https protocol.
 *
 * @example
 * ```typescript
 * const identity = generateAgentIdentity('https://agent.example.com');
 * // { agentId: 'did:key:z6Mk...', keypair: { publicKey, secretKey }, endpoint: 'https://...' }
 * ```
 */
export function generateAgentIdentity(endpoint: string): {
  agentId: string;
  keypair: { publicKey: Uint8Array; secretKey: Uint8Array };
  endpoint: string;
} {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'endpoint must be a non-empty string',
    );
  }
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `endpoint must use http or https protocol, got: ${url.protocol}`,
      );
    }
  } catch (e) {
    if (e instanceof OphirError) throw e;
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      `endpoint is not a valid URL: ${endpoint}`,
    );
  }
  const keypair = generateKeyPair();
  const agentId = publicKeyToDid(keypair.publicKey);
  return { agentId, keypair, endpoint };
}
