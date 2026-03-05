import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  canonicalize,
  sign,
  verify,
  agreementHash,
  signMessage,
  verifyMessage,
} from '../signing.js';
import {
  generateKeyPair,
  publicKeyToDid,
  didToPublicKey,
  generateAgentIdentity,
} from '../identity.js';
import { buildRFQ, buildReject } from '../messages.js';
import type { FinalTerms } from '@ophir/protocol';

describe('canonicalize', () => {
  it('produces deterministic output regardless of key order', () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('handles nested objects deterministically', () => {
    const a = { outer: { z: 1, a: 2 }, list: [3, 1, 2] };
    const b = { list: [3, 1, 2], outer: { a: 2, z: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('handles arrays preserving element order', () => {
    const obj = { items: [3, 1, 2] };
    const result = canonicalize(obj);
    expect(result).toBe('{"items":[3,1,2]}');
  });

  it('handles null values', () => {
    const obj = { a: null, b: 1 };
    const result = canonicalize(obj);
    expect(result).toContain('"a":null');
  });

  it('excludes undefined values', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    const result = canonicalize(obj);
    expect(result).not.toContain('"b"');
    expect(result).toContain('"a":1');
    expect(result).toContain('"c":3');
  });

  it('produces identical output for equivalent objects with different construction', () => {
    const a: Record<string, unknown> = {};
    a['x'] = 10;
    a['y'] = 20;
    const b: Record<string, unknown> = {};
    b['y'] = 20;
    b['x'] = 10;
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('handles booleans and numbers correctly', () => {
    const obj = { flag: true, count: 42, ratio: 3.14, off: false };
    const result = canonicalize(obj);
    expect(result).toContain('"flag":true');
    expect(result).toContain('"count":42');
    expect(result).toContain('"ratio":3.14');
    expect(result).toContain('"off":false');
  });
});

describe('sign and verify', () => {
  const keypair = nacl.sign.keyPair();

  it('roundtrip: sign then verify succeeds', () => {
    const data = new TextEncoder().encode('hello ophir');
    const signature = sign(data, keypair.secretKey);
    expect(verify(data, signature, keypair.publicKey)).toBe(true);
  });

  it('rejects verification with wrong public key', () => {
    const data = new TextEncoder().encode('hello ophir');
    const signature = sign(data, keypair.secretKey);
    const wrongKey = nacl.sign.keyPair().publicKey;
    expect(verify(data, signature, wrongKey)).toBe(false);
  });

  it('rejects verification with tampered data (flip one byte)', () => {
    const data = new TextEncoder().encode('hello ophir');
    const signature = sign(data, keypair.secretKey);
    const tampered = new Uint8Array(data);
    tampered[0] ^= 0xff;
    expect(verify(tampered, signature, keypair.publicKey)).toBe(false);
  });

  it('rejects truncated signature', () => {
    const data = new TextEncoder().encode('hello ophir');
    const signature = sign(data, keypair.secretKey);
    const truncated = signature.slice(0, 10);
    expect(verify(data, truncated, keypair.publicKey)).toBe(false);
  });

  it('rejects empty signature', () => {
    const data = new TextEncoder().encode('hello ophir');
    expect(verify(data, '', keypair.publicKey)).toBe(false);
  });

  it('throws on invalid secret key length', () => {
    const data = new TextEncoder().encode('hello ophir');
    const badKey = new Uint8Array(32); // should be 64
    expect(() => sign(data, badKey)).toThrow('Invalid secret key length');
  });

  it('returns false for garbage signature string', () => {
    const data = new TextEncoder().encode('hello ophir');
    expect(verify(data, '!!!not-base64-at-all!!!', keypair.publicKey)).toBe(false);
  });

  it('returns false when publicKey is wrong length', () => {
    const data = new TextEncoder().encode('hello ophir');
    const signature = sign(data, keypair.secretKey);
    const shortKey = new Uint8Array(16);
    expect(verify(data, signature, shortKey)).toBe(false);
  });

  it('returns false for all-zero signature', () => {
    const data = new TextEncoder().encode('hello ophir');
    const zeroSig = Buffer.from(new Uint8Array(64)).toString('base64');
    expect(verify(data, zeroSig, keypair.publicKey)).toBe(false);
  });

  it('verify with empty Uint8Array data still works correctly', () => {
    const emptyData = new Uint8Array(0);
    const signature = sign(emptyData, keypair.secretKey);
    expect(verify(emptyData, signature, keypair.publicKey)).toBe(true);
  });

  it('signMessage with empty object produces valid signature', () => {
    const sig = signMessage({}, keypair.secretKey);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    expect(verifyMessage({}, sig, keypair.publicKey)).toBe(true);
  });

  it('verifyMessage with deeply nested objects is deterministic', () => {
    const nested1 = { a: { b: { c: { d: 1 } } }, x: [1, { y: 2 }] };
    const nested2 = { x: [1, { y: 2 }], a: { b: { c: { d: 1 } } } };
    const sig = signMessage(nested1, keypair.secretKey);
    expect(verifyMessage(nested2, sig, keypair.publicKey)).toBe(true);
  });

  it('agreementHash with identical nested structures', () => {
    const terms1 = { price_per_unit: '0.01', metadata: { region: 'us', tier: 'premium' }, currency: 'USDC', unit: 'request' };
    const terms2 = { currency: 'USDC', unit: 'request', metadata: { tier: 'premium', region: 'us' }, price_per_unit: '0.01' };
    expect(agreementHash(terms1)).toBe(agreementHash(terms2));
  });
});

describe('agreementHash', () => {
  it('is deterministic for same final terms', () => {
    const terms = {
      price_per_unit: '0.01',
      currency: 'USDC',
      unit: 'request',
    };
    const hash1 = agreementHash(terms);
    const hash2 = agreementHash(terms);
    expect(hash1).toBe(hash2);
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const terms = {
      price_per_unit: '0.05',
      currency: 'USDC',
      unit: 'token',
    };
    const hash = agreementHash(terms);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when terms differ', () => {
    const terms1 = { price_per_unit: '0.01', currency: 'USDC', unit: 'req' };
    const terms2 = { price_per_unit: '0.02', currency: 'USDC', unit: 'req' };
    expect(agreementHash(terms1)).not.toBe(agreementHash(terms2));
  });
});

describe('signMessage and verifyMessage', () => {
  const keypair = nacl.sign.keyPair();

  it('roundtrip with arbitrary params object', () => {
    const params = { rfq_id: 'rfq-001', price: '10.00', currency: 'USDC' };
    const sig = signMessage(params, keypair.secretKey);
    expect(verifyMessage(params, sig, keypair.publicKey)).toBe(true);
  });

  it('rejects when params differ', () => {
    const params = { rfq_id: 'rfq-001', price: '10.00' };
    const sig = signMessage(params, keypair.secretKey);
    const altered = { rfq_id: 'rfq-001', price: '20.00' };
    expect(verifyMessage(altered, sig, keypair.publicKey)).toBe(false);
  });

  it('signature is key-order independent', () => {
    const params1 = { a: 1, b: 2 };
    const params2 = { b: 2, a: 1 };
    const sig = signMessage(params1, keypair.secretKey);
    expect(verifyMessage(params2, sig, keypair.publicKey)).toBe(true);
  });
});

describe('DID:key identity', () => {
  it('generates a valid keypair with correct lengths', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toHaveLength(32);
    expect(kp.secretKey).toHaveLength(64);
  });

  it('two generateKeyPair calls produce different keys', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(Buffer.from(kp1.publicKey)).not.toEqual(Buffer.from(kp2.publicKey));
    expect(Buffer.from(kp1.secretKey)).not.toEqual(Buffer.from(kp2.secretKey));
  });

  it('roundtrips publicKey through DID conversion', () => {
    const kp = generateKeyPair();
    const did = publicKeyToDid(kp.publicKey);
    expect(did).toMatch(/^did:key:z6Mk/);
    const recovered = didToPublicKey(did);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(kp.publicKey));
  });

  it('DID starts with did:key:z6Mk', () => {
    const kp = generateKeyPair();
    const did = publicKeyToDid(kp.publicKey);
    expect(did.startsWith('did:key:z6Mk')).toBe(true);
  });

  it('throws on invalid DID prefix', () => {
    expect(() => didToPublicKey('did:web:example.com')).toThrow(
      'Invalid did:key format',
    );
  });

  it('throws on wrong multicodec prefix', () => {
    // Construct a did:key with wrong multicodec bytes (0x00, 0x00 instead of 0xed, 0x01)
    const fakeKey = new Uint8Array(34);
    fakeKey[0] = 0x00;
    fakeKey[1] = 0x00;
    // Import bs58 to encode
    const fakeDid = `did:key:z${bs58.encode(fakeKey)}`;
    expect(() => didToPublicKey(fakeDid)).toThrow('Invalid multicodec prefix');
  });

  it('generateAgentIdentity returns complete bundle', () => {
    const identity = generateAgentIdentity('https://agent.example.com');
    expect(identity.agentId).toMatch(/^did:key:z6Mk/);
    expect(identity.endpoint).toBe('https://agent.example.com');
    expect(identity.keypair.publicKey).toHaveLength(32);
    expect(identity.keypair.secretKey).toHaveLength(64);
    const did = publicKeyToDid(identity.keypair.publicKey);
    expect(identity.agentId).toBe(did);
  });

  it('throws on publicKey shorter than 32 bytes', () => {
    const shortKey = new Uint8Array(16);
    expect(() => publicKeyToDid(shortKey)).toThrow('Invalid public key length: expected 32, got 16');
  });

  it('throws on publicKey longer than 32 bytes', () => {
    const longKey = new Uint8Array(48);
    expect(() => publicKeyToDid(longKey)).toThrow('Invalid public key length: expected 32, got 48');
  });

  it('throws on empty publicKey', () => {
    const emptyKey = new Uint8Array(0);
    expect(() => publicKeyToDid(emptyKey)).toThrow('Invalid public key length: expected 32, got 0');
  });

  it('throws on DID with truncated key (decoded < 34 bytes)', () => {
    // A valid DID encodes 2-byte prefix + 32-byte key = 34 bytes.
    // Here we encode only 2-byte prefix + 10-byte key = 12 bytes.
    const truncated = new Uint8Array(12);
    truncated[0] = 0xed;
    truncated[1] = 0x01;
    const fakeDid = `did:key:z${bs58.encode(truncated)}`;
    expect(() => didToPublicKey(fakeDid)).toThrow('Invalid public key length after DID decoding: expected 32, got 10');
  });

  it('throws on DID with extra bytes (decoded > 34 bytes)', () => {
    const oversized = new Uint8Array(40); // 2 prefix + 38 key bytes
    oversized[0] = 0xed;
    oversized[1] = 0x01;
    const fakeDid = `did:key:z${bs58.encode(oversized)}`;
    expect(() => didToPublicKey(fakeDid)).toThrow('Invalid public key length after DID decoding: expected 32, got 38');
  });
});

describe('cross-verification', () => {
  it('sign with one keypair, verify fails with another', () => {
    const kp1 = nacl.sign.keyPair();
    const kp2 = nacl.sign.keyPair();
    const data = new TextEncoder().encode('cross-verify test');
    const signature = sign(data, kp1.secretKey);
    expect(verify(data, signature, kp1.publicKey)).toBe(true);
    expect(verify(data, signature, kp2.publicKey)).toBe(false);
  });

  it('signMessage with one keypair, verifyMessage fails with another', () => {
    const kp1 = nacl.sign.keyPair();
    const kp2 = nacl.sign.keyPair();
    const params = { action: 'transfer', amount: '100' };
    const sig = signMessage(params, kp1.secretKey);
    expect(verifyMessage(params, sig, kp1.publicKey)).toBe(true);
    expect(verifyMessage(params, sig, kp2.publicKey)).toBe(false);
  });
});

describe('input validation edge cases', () => {
  it('canonicalize throws on undefined input', () => {
    expect(() => canonicalize(undefined)).toThrow('Cannot canonicalize undefined');
  });

  it('canonicalize throws on function input', () => {
    expect(() => canonicalize(() => {})).toThrow('Cannot canonicalize function');
  });

  it('canonicalize throws on symbol input', () => {
    expect(() => canonicalize(Symbol('test'))).toThrow('Cannot canonicalize symbol');
  });

  it('canonicalize handles empty object', () => {
    const result = canonicalize({});
    expect(result).toBe('{}');
  });

  it('canonicalize handles empty array', () => {
    const result = canonicalize([]);
    expect(result).toBe('[]');
  });

  it('sign with valid 64-byte key and empty data works', () => {
    const kp = nacl.sign.keyPair();
    const emptyData = new Uint8Array(0);
    const signature = sign(emptyData, kp.secretKey);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
    expect(verify(emptyData, signature, kp.publicKey)).toBe(true);
  });

  it('verify returns false for very long signature string', () => {
    const kp = nacl.sign.keyPair();
    const data = new TextEncoder().encode('test');
    const longSig = Buffer.from(new Uint8Array(256)).toString('base64');
    expect(verify(data, longSig, kp.publicKey)).toBe(false);
  });
});

describe('edge cases and error handling', () => {
  const keypair = nacl.sign.keyPair();

  // 1. sign() throws for non-Uint8Array input
  it('sign() throws for non-Uint8Array input', () => {
    expect(() => sign('not a uint8array' as unknown as Uint8Array, keypair.secretKey)).toThrow(
      'canonicalBytes must be a Uint8Array',
    );
  });

  // 2. sign() throws for wrong-length secret key
  it('sign() throws for wrong-length secret key', () => {
    const data = new TextEncoder().encode('test');
    const shortKey = new Uint8Array(32);
    expect(() => sign(data, shortKey)).toThrow('Invalid secret key length');
  });

  // 3. verify() returns false for non-Uint8Array canonicalBytes
  it('verify() returns false for non-Uint8Array canonicalBytes', () => {
    const sig = sign(new TextEncoder().encode('test'), keypair.secretKey);
    expect(verify('not a uint8array' as unknown as Uint8Array, sig, keypair.publicKey)).toBe(false);
  });

  // 4. verify() returns false for wrong-length public key
  it('verify() returns false for wrong-length public key', () => {
    const data = new TextEncoder().encode('test');
    const sig = sign(data, keypair.secretKey);
    const badKey = new Uint8Array(10);
    expect(verify(data, sig, badKey)).toBe(false);
  });

  // 5. verify() returns false for wrong-length signature
  it('verify() returns false for wrong-length signature', () => {
    const data = new TextEncoder().encode('test');
    // 32 bytes encodes to base64, but Ed25519 signatures are 64 bytes
    const shortSig = Buffer.from(new Uint8Array(32)).toString('base64');
    expect(verify(data, shortSig, keypair.publicKey)).toBe(false);
  });

  // 6. signMessage() throws for null params
  it('signMessage() throws for null params', () => {
    expect(() => signMessage(null, keypair.secretKey)).toThrow(
      'params must not be null or undefined',
    );
  });

  // 7. signMessage() throws for undefined params
  it('signMessage() throws for undefined params', () => {
    expect(() => signMessage(undefined, keypair.secretKey)).toThrow(
      'params must not be null or undefined',
    );
  });

  // 8. verifyMessage() returns false for empty signature
  it('verifyMessage() returns false for empty signature', () => {
    const params = { action: 'test' };
    expect(verifyMessage(params, '', keypair.publicKey)).toBe(false);
  });

  // 9. verifyMessage() returns false for non-string signature
  it('verifyMessage() returns false for non-string signature', () => {
    const params = { action: 'test' };
    expect(verifyMessage(params, 12345 as unknown as string, keypair.publicKey)).toBe(false);
    expect(verifyMessage(params, null as unknown as string, keypair.publicKey)).toBe(false);
    expect(verifyMessage(params, undefined as unknown as string, keypair.publicKey)).toBe(false);
  });

  // 10. agreementHash() throws for null finalTerms
  it('agreementHash() throws for null finalTerms', () => {
    expect(() => agreementHash(null as unknown as FinalTerms)).toThrow(
      'finalTerms must be a non-null object',
    );
  });

  // 11. agreementHash() throws for missing required fields
  it('agreementHash() throws for missing required fields', () => {
    expect(() => agreementHash({ price_per_unit: '0.01' } as unknown as FinalTerms)).toThrow(
      'finalTerms must contain price_per_unit, currency, and unit',
    );
    expect(() => agreementHash({ currency: 'USDC' } as unknown as FinalTerms)).toThrow(
      'finalTerms must contain price_per_unit, currency, and unit',
    );
    expect(() => agreementHash({} as unknown as FinalTerms)).toThrow(
      'finalTerms must contain price_per_unit, currency, and unit',
    );
  });

  // 12. agreementHash() produces consistent output for same input
  it('agreementHash() produces consistent output for same input', () => {
    const terms = { price_per_unit: '0.10', currency: 'USDC', unit: 'request' };
    const hash1 = agreementHash(terms);
    const hash2 = agreementHash(terms);
    const hash3 = agreementHash({ ...terms });
    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // 13. agreementHash() produces different output for different inputs
  it('agreementHash() produces different output for different inputs', () => {
    const termsA = { price_per_unit: '0.01', currency: 'USDC', unit: 'request' };
    const termsB = { price_per_unit: '0.01', currency: 'USDC', unit: 'token' };
    const termsC = { price_per_unit: '0.02', currency: 'USDC', unit: 'request' };
    const hashA = agreementHash(termsA);
    const hashB = agreementHash(termsB);
    const hashC = agreementHash(termsC);
    expect(hashA).not.toBe(hashB);
    expect(hashA).not.toBe(hashC);
    expect(hashB).not.toBe(hashC);
  });
});

describe('crypto edge cases', () => {
  const keypairA = nacl.sign.keyPair();
  const keypairB = nacl.sign.keyPair();

  it('agreementHash includes SLA in commitment', () => {
    const base = { price_per_unit: '0.05', currency: 'USDC', unit: 'request' };
    const withSla = {
      ...base,
      sla: { metric: 'latency_p99', threshold: '200ms', penalty: '0.01' },
    };
    const withoutSla = { ...base };
    expect(agreementHash(withSla as unknown as FinalTerms)).not.toBe(agreementHash(withoutSla));
  });

  it('agreementHash includes escrow in commitment', () => {
    const base = { price_per_unit: '0.05', currency: 'USDC', unit: 'request' };
    const withEscrow = {
      ...base,
      escrow: { network: 'solana', deposit_amount: '100.00', release_condition: 'sla_met' },
    };
    const withoutEscrow = { ...base };
    expect(agreementHash(withEscrow as FinalTerms)).not.toBe(agreementHash(withoutEscrow));
  });

  it('signMessage with array top-level', () => {
    const arr = [1, 2, 3];
    const sig = signMessage(arr, keypairA.secretKey);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    expect(verifyMessage(arr, sig, keypairA.publicKey)).toBe(true);
  });

  it('signMessage with deeply nested object', () => {
    const deep = {
      level1: {
        level2: {
          level3: {
            level4: { value: 'deep', nums: [1, 2, { nested: true }] },
          },
        },
      },
      sibling: [{ a: 1 }, { b: 2 }],
    };
    const sig = signMessage(deep, keypairA.secretKey);
    // Reconstruct in different key order
    const deep2 = {
      sibling: [{ a: 1 }, { b: 2 }],
      level1: {
        level2: {
          level3: {
            level4: { nums: [1, 2, { nested: true }], value: 'deep' },
          },
        },
      },
    };
    expect(verifyMessage(deep2, sig, keypairA.publicKey)).toBe(true);
  });

  it('canonicalize handles Unicode/multibyte strings', () => {
    const obj1 = { greeting: '\u{1F600}', name: '\u00E9\u00E8\u00EA', kanji: '\u6F22\u5B57' };
    const obj2 = { kanji: '\u6F22\u5B57', greeting: '\u{1F600}', name: '\u00E9\u00E8\u00EA' };
    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    // Verify it produces consistent output across multiple calls
    expect(canonicalize(obj1)).toBe(canonicalize(obj1));
  });

  it('canonicalize with special JSON values', () => {
    const obj = { zero: 0, negZero: -0, empty: '', long: 'x'.repeat(10000) };
    const result = canonicalize(obj);
    expect(result).toContain('"zero":0');
    expect(result).toContain('"empty":""');
    expect(result).toContain('"long":"' + 'x'.repeat(10000) + '"');
    // Determinism check
    expect(canonicalize(obj)).toBe(result);
  });

  it('sign output is base64 encoded and 88 chars', () => {
    const data = new TextEncoder().encode('test data for length check');
    const sig = sign(data, keypairA.secretKey);
    // Ed25519 signature is 64 bytes, base64 of 64 bytes = 88 chars (with padding)
    expect(sig).toHaveLength(88);
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('verify rejects signature with wrong length (63 bytes, 65 bytes)', () => {
    const data = new TextEncoder().encode('length test');
    const short63 = Buffer.from(new Uint8Array(63)).toString('base64');
    const long65 = Buffer.from(new Uint8Array(65)).toString('base64');
    expect(verify(data, short63, keypairA.publicKey)).toBe(false);
    expect(verify(data, long65, keypairA.publicKey)).toBe(false);
  });

  it('signMessage with empty object', () => {
    const sig = signMessage({}, keypairA.secretKey);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    expect(verifyMessage({}, sig, keypairA.publicKey)).toBe(true);
  });

  it('verifyMessage with tampered single character', () => {
    const params = { action: 'transfer', amount: '500' };
    const sig = signMessage(params, keypairA.secretKey);
    expect(verifyMessage(params, sig, keypairA.publicKey)).toBe(true);
    // Tamper with one character in the middle of the signature
    const chars = sig.split('');
    const midIdx = Math.floor(chars.length / 2);
    chars[midIdx] = chars[midIdx] === 'A' ? 'B' : 'A';
    const tampered = chars.join('');
    expect(verifyMessage(params, tampered, keypairA.publicKey)).toBe(false);
  });

  it('agreementHash is lowercase hex', () => {
    const terms = { price_per_unit: '1.00', currency: 'USDC', unit: 'call' };
    const hash = agreementHash(terms);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Ensure no uppercase hex chars
    expect(hash).toBe(hash.toLowerCase());
  });

  it('cross-keypair verification fails', () => {
    const params = { contract: 'abc-123', value: '42' };
    const sig = signMessage(params, keypairA.secretKey);
    // Correct keypair succeeds
    expect(verifyMessage(params, sig, keypairA.publicKey)).toBe(true);
    // Wrong keypair fails
    expect(verifyMessage(params, sig, keypairB.publicKey)).toBe(false);
  });
});

describe('known test vectors', () => {
  // Use a fixed seed to get deterministic keys
  const seed = new Uint8Array(32).fill(42);
  const keypair = nacl.sign.keyPair.fromSeed(seed);

  it('produces deterministic signature for known input', () => {
    const msg = { hello: 'world' };
    const sig1 = signMessage(msg, keypair.secretKey);
    const sig2 = signMessage(msg, keypair.secretKey);
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(88); // base64 of 64 bytes
  });

  it('known canonical form is correct', () => {
    const canonical = canonicalize({ z: 1, a: 2, m: { x: true } });
    expect(canonical).toBe('{"a":2,"m":{"x":true},"z":1}');
  });

  it('agreementHash is deterministic for same terms', () => {
    const terms = { price_per_unit: '0.01', currency: 'USDC', unit: 'request' };
    const hash1 = agreementHash(terms as any);
    const hash2 = agreementHash(terms as any);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cross-keypair isolation', () => {
  it('signature from keypair A fails verification with keypair B', () => {
    const kpA = nacl.sign.keyPair();
    const kpB = nacl.sign.keyPair();
    const msg = { test: 'data' };
    const sig = signMessage(msg, kpA.secretKey);
    expect(verifyMessage(msg, sig, kpA.publicKey)).toBe(true);
    expect(verifyMessage(msg, sig, kpB.publicKey)).toBe(false);
  });

  it('10 random keypairs all produce unique signatures for same message', () => {
    const msg = { same: 'message' };
    const sigs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const kp = nacl.sign.keyPair();
      sigs.add(signMessage(msg, kp.secretKey));
    }
    expect(sigs.size).toBe(10);
  });
});

describe('canonicalize advanced edge cases', () => {
  it('handles deeply nested objects', () => {
    const deep = { a: { b: { c: { d: { e: 'value' } } } } };
    const result = canonicalize(deep);
    expect(result).toBe('{"a":{"b":{"c":{"d":{"e":"value"}}}}}');
  });

  it('handles arrays with mixed types', () => {
    const mixed = [1, 'two', true, null, { three: 3 }];
    const result = canonicalize(mixed);
    expect(result).toBe('[1,"two",true,null,{"three":3}]');
  });

  it('handles empty object', () => {
    expect(canonicalize({})).toBe('{}');
  });

  it('handles empty array', () => {
    expect(canonicalize([])).toBe('[]');
  });

  it('handles empty string', () => {
    expect(canonicalize('')).toBe('""');
  });

  it('handles zero', () => {
    expect(canonicalize(0)).toBe('0');
  });

  it('handles boolean false', () => {
    expect(canonicalize(false)).toBe('false');
  });

  it('handles null', () => {
    expect(canonicalize(null)).toBe('null');
  });

  it('strips undefined values from objects', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    const result = canonicalize(obj);
    expect(result).toBe('{"a":1,"c":3}');
  });
});

describe('signature tamper detection', () => {
  it('detects single-bit change in signature', () => {
    const kp = nacl.sign.keyPair();
    const msg = { amount: '100.00', currency: 'USDC' };
    const sig = signMessage(msg, kp.secretKey);

    // Flip one bit in the signature
    const sigBytes = Buffer.from(sig, 'base64');
    sigBytes[0] ^= 1;
    const tamperedSig = sigBytes.toString('base64');

    expect(verifyMessage(msg, sig, kp.publicKey)).toBe(true);
    expect(verifyMessage(msg, tamperedSig, kp.publicKey)).toBe(false);
  });

  it('detects single-character change in signed data', () => {
    const kp = nacl.sign.keyPair();
    const msg = { price: '0.01' };
    const sig = signMessage(msg, kp.secretKey);

    expect(verifyMessage(msg, sig, kp.publicKey)).toBe(true);
    expect(verifyMessage({ price: '0.02' }, sig, kp.publicKey)).toBe(false);
    expect(verifyMessage({ price: '0.011' }, sig, kp.publicKey)).toBe(false);
  });

  it('detects added field in signed data', () => {
    const kp = nacl.sign.keyPair();
    const msg = { a: 1 };
    const sig = signMessage(msg, kp.secretKey);

    expect(verifyMessage(msg, sig, kp.publicKey)).toBe(true);
    expect(verifyMessage({ a: 1, b: 2 }, sig, kp.publicKey)).toBe(false);
  });

  it('detects removed field from signed data', () => {
    const kp = nacl.sign.keyPair();
    const msg = { a: 1, b: 2 };
    const sig = signMessage(msg, kp.secretKey);

    expect(verifyMessage(msg, sig, kp.publicKey)).toBe(true);
    expect(verifyMessage({ a: 1 }, sig, kp.publicKey)).toBe(false);
  });
});

describe('agreementHash security properties', () => {
  it('different prices produce different hashes', () => {
    const h1 = agreementHash({ price_per_unit: '0.01', currency: 'USDC', unit: 'request' } as any);
    const h2 = agreementHash({ price_per_unit: '0.02', currency: 'USDC', unit: 'request' } as any);
    expect(h1).not.toBe(h2);
  });

  it('different currencies produce different hashes', () => {
    const h1 = agreementHash({ price_per_unit: '0.01', currency: 'USDC', unit: 'request' } as any);
    const h2 = agreementHash({ price_per_unit: '0.01', currency: 'SOL', unit: 'request' } as any);
    expect(h1).not.toBe(h2);
  });

  it('different units produce different hashes', () => {
    const h1 = agreementHash({ price_per_unit: '0.01', currency: 'USDC', unit: 'request' } as any);
    const h2 = agreementHash({ price_per_unit: '0.01', currency: 'USDC', unit: 'token' } as any);
    expect(h1).not.toBe(h2);
  });

  it('with and without optional SLA produce different hashes', () => {
    const base = { price_per_unit: '0.01', currency: 'USDC', unit: 'request' };
    const withSla = { ...base, sla: { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }] } };
    const h1 = agreementHash(base as any);
    const h2 = agreementHash(withSla as any);
    expect(h1).not.toBe(h2);
  });

  it('hash is exactly 64 hex characters', () => {
    const hash = agreementHash({ price_per_unit: '1', currency: 'USD', unit: 'call' } as any);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildRFQ signing integration', () => {
  it('buildRFQ produces a signed RFQ verifiable with buyer key', () => {
    const kp = generateKeyPair();
    const buyerDid = publicKeyToDid(kp.publicKey);
    const rfq = buildRFQ({
      buyer: { agent_id: buyerDid, endpoint: 'https://buyer.example.com' },
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });
    const { signature, ...unsigned } = rfq.params;
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('buildReject produces a signed Reject verifiable with signer key', () => {
    const kp = generateKeyPair();
    const agentDid = publicKeyToDid(kp.publicKey);
    const reject = buildReject({
      rfqId: '00000000-0000-0000-0000-000000000001',
      rejectingMessageId: '00000000-0000-0000-0000-000000000002',
      reason: 'Price too high',
      agentId: agentDid,
      secretKey: kp.secretKey,
    });
    const { signature, ...unsigned } = reject.params;
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('forged RFQ: signed with key A, verified with key B fails', () => {
    const kpA = generateKeyPair();
    const kpB = generateKeyPair();
    const buyerDid = publicKeyToDid(kpA.publicKey);
    const rfq = buildRFQ({
      buyer: { agent_id: buyerDid, endpoint: 'https://buyer.example.com' },
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kpA.secretKey,
    });
    const { signature, ...unsigned } = rfq.params;
    expect(verifyMessage(unsigned, signature, kpB.publicKey)).toBe(false);
  });

  it('RFQ with tampered buyer.agent_id after signing has invalid signature', () => {
    const kp = generateKeyPair();
    const buyerDid = publicKeyToDid(kp.publicKey);
    const rfq = buildRFQ({
      buyer: { agent_id: buyerDid, endpoint: 'https://buyer.example.com' },
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });
    const { signature, ...unsigned } = rfq.params;
    // Tamper with buyer.agent_id
    const tampered = { ...unsigned, buyer: { ...unsigned.buyer, agent_id: 'did:key:z6MkFAKE' } };
    expect(verifyMessage(tampered, signature, kp.publicKey)).toBe(false);
  });
});

describe('canonicalize special characters', () => {
  it('canonicalize with newlines and tabs in strings', () => {
    const obj = { a: 'line1\nline2', b: 'tab\there' };
    const result1 = canonicalize(obj);
    const result2 = canonicalize(obj);
    expect(result1).toBe(result2);
    expect(typeof result1).toBe('string');
    expect(result1.length).toBeGreaterThan(0);
  });

  it('canonicalize with emoji in strings', () => {
    const obj = { smile: '\u{1F604}', rocket: '\u{1F680}', key: 'value' };
    const result1 = canonicalize(obj);
    const result2 = canonicalize({ key: 'value', rocket: '\u{1F680}', smile: '\u{1F604}' });
    expect(result1).toBe(result2);
    expect(typeof result1).toBe('string');
    expect(result1.length).toBeGreaterThan(0);
  });
});
