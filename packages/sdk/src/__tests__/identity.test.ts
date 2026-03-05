import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import {
  generateKeyPair,
  publicKeyToDid,
  didToPublicKey,
  generateAgentIdentity,
} from '../identity.js';
import { OphirError, OphirErrorCode } from '@ophirai/protocol';

describe('generateKeyPair', () => {
  it('returns publicKey of 32 bytes', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toHaveLength(32);
  });

  it('returns secretKey of 64 bytes', () => {
    const kp = generateKeyPair();
    expect(kp.secretKey).toHaveLength(64);
  });

  it('publicKey is a Uint8Array', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
  });

  it('secretKey is a Uint8Array', () => {
    const kp = generateKeyPair();
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
  });

  it('two calls produce different public keys (entropy check)', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(Buffer.from(kp1.publicKey)).not.toEqual(Buffer.from(kp2.publicKey));
  });

  it('two calls produce different secret keys', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(Buffer.from(kp1.secretKey)).not.toEqual(Buffer.from(kp2.secretKey));
  });

  it('ten consecutive keypairs are all unique', () => {
    const keys = Array.from({ length: 10 }, () => generateKeyPair());
    const publicKeyHexes = keys.map((kp) => Buffer.from(kp.publicKey).toString('hex'));
    const uniqueKeys = new Set(publicKeyHexes);
    expect(uniqueKeys.size).toBe(10);
  });
});

describe('publicKeyToDid', () => {
  it('valid 32-byte key produces a DID starting with did:key:z', () => {
    const kp = generateKeyPair();
    const did = publicKeyToDid(kp.publicKey);
    expect(did.startsWith('did:key:z')).toBe(true);
  });

  it('valid key produces DID matching did:key:z6Mk prefix', () => {
    const kp = generateKeyPair();
    const did = publicKeyToDid(kp.publicKey);
    expect(did).toMatch(/^did:key:z6Mk/);
  });

  it('all-zero 32-byte key produces a valid DID', () => {
    const zeroKey = new Uint8Array(32);
    const did = publicKeyToDid(zeroKey);
    expect(did.startsWith('did:key:z')).toBe(true);
    expect(did.length).toBeGreaterThan('did:key:z'.length);
  });

  it('same key produces same DID (deterministic)', () => {
    const kp = generateKeyPair();
    const did1 = publicKeyToDid(kp.publicKey);
    const did2 = publicKeyToDid(kp.publicKey);
    expect(did1).toBe(did2);
  });

  it('throws OphirError on key shorter than 32 bytes', () => {
    const shortKey = new Uint8Array(16);
    expect(() => publicKeyToDid(shortKey)).toThrow(OphirError);
    expect(() => publicKeyToDid(shortKey)).toThrow('Invalid public key length: expected 32, got 16');
  });

  it('throws OphirError on key longer than 32 bytes', () => {
    const longKey = new Uint8Array(48);
    expect(() => publicKeyToDid(longKey)).toThrow(OphirError);
    expect(() => publicKeyToDid(longKey)).toThrow('Invalid public key length: expected 32, got 48');
  });

  it('throws OphirError on empty key (0 bytes)', () => {
    const emptyKey = new Uint8Array(0);
    expect(() => publicKeyToDid(emptyKey)).toThrow('Invalid public key length: expected 32, got 0');
  });

  it('throws with INVALID_MESSAGE error code', () => {
    const shortKey = new Uint8Array(10);
    try {
      publicKeyToDid(shortKey);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OphirError);
      expect((e as OphirError).code).toBe(OphirErrorCode.INVALID_MESSAGE);
    }
  });
});

describe('didToPublicKey', () => {
  it('roundtrip: publicKeyToDid then didToPublicKey recovers original key', () => {
    const kp = generateKeyPair();
    const did = publicKeyToDid(kp.publicKey);
    const recovered = didToPublicKey(did);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(kp.publicKey));
  });

  it('recovered key is a Uint8Array of length 32', () => {
    const kp = generateKeyPair();
    const did = publicKeyToDid(kp.publicKey);
    const recovered = didToPublicKey(did);
    expect(recovered).toBeInstanceOf(Uint8Array);
    expect(recovered).toHaveLength(32);
  });

  it('throws on invalid prefix (did:web:...)', () => {
    expect(() => didToPublicKey('did:web:example.com')).toThrow('Invalid did:key format');
  });

  it('throws on invalid prefix (did:ethr:...)', () => {
    expect(() => didToPublicKey('did:ethr:0xabc')).toThrow('Invalid did:key format');
  });

  it('throws on wrong multicodec prefix', () => {
    const fakePayload = new Uint8Array(34);
    fakePayload[0] = 0x00;
    fakePayload[1] = 0x00;
    const fakeDid = `did:key:z${bs58.encode(fakePayload)}`;
    expect(() => didToPublicKey(fakeDid)).toThrow('Invalid multicodec prefix');
  });

  it('throws on truncated key (fewer than 32 bytes after prefix)', () => {
    const truncated = new Uint8Array(12);
    truncated[0] = 0xed;
    truncated[1] = 0x01;
    const fakeDid = `did:key:z${bs58.encode(truncated)}`;
    expect(() => didToPublicKey(fakeDid)).toThrow('Invalid public key length after DID decoding: expected 32, got 10');
  });

  it('throws on oversized key (more than 32 bytes after prefix)', () => {
    const oversized = new Uint8Array(40);
    oversized[0] = 0xed;
    oversized[1] = 0x01;
    const fakeDid = `did:key:z${bs58.encode(oversized)}`;
    expect(() => didToPublicKey(fakeDid)).toThrow('Invalid public key length after DID decoding: expected 32, got 38');
  });

  it('throws on empty string', () => {
    expect(() => didToPublicKey('')).toThrow('DID must be a non-empty string');
  });

  it('throws on non-string input (number)', () => {
    expect(() => didToPublicKey(12345 as unknown as string)).toThrow('DID must be a non-empty string');
  });

  it('throws on non-string input (null)', () => {
    expect(() => didToPublicKey(null as unknown as string)).toThrow('DID must be a non-empty string');
  });

  it('throws on non-string input (undefined)', () => {
    expect(() => didToPublicKey(undefined as unknown as string)).toThrow('DID must be a non-empty string');
  });

  it('throws with INVALID_MESSAGE error code for empty string', () => {
    try {
      didToPublicKey('');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OphirError);
      expect((e as OphirError).code).toBe(OphirErrorCode.INVALID_MESSAGE);
    }
  });
});

describe('generateAgentIdentity', () => {
  it('valid HTTPS endpoint returns complete identity bundle', () => {
    const identity = generateAgentIdentity('https://agent.example.com');
    expect(identity.agentId).toMatch(/^did:key:z6Mk/);
    expect(identity.endpoint).toBe('https://agent.example.com');
    expect(identity.keypair.publicKey).toHaveLength(32);
    expect(identity.keypair.secretKey).toHaveLength(64);
  });

  it('valid HTTP endpoint is accepted', () => {
    const identity = generateAgentIdentity('http://localhost:3000');
    expect(identity.agentId).toMatch(/^did:key:z/);
    expect(identity.endpoint).toBe('http://localhost:3000');
  });

  it('agentId matches the keypair public key DID', () => {
    const identity = generateAgentIdentity('https://agent.example.com');
    const expectedDid = publicKeyToDid(identity.keypair.publicKey);
    expect(identity.agentId).toBe(expectedDid);
  });

  it('agentId can be decoded back to the keypair public key', () => {
    const identity = generateAgentIdentity('https://agent.example.com');
    const recovered = didToPublicKey(identity.agentId);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(identity.keypair.publicKey));
  });

  it('throws OphirError on invalid URL string', () => {
    expect(() => generateAgentIdentity('not-a-url')).toThrow(OphirError);
    expect(() => generateAgentIdentity('not-a-url')).toThrow('endpoint is not a valid URL');
  });

  it('throws OphirError on empty string', () => {
    expect(() => generateAgentIdentity('')).toThrow(OphirError);
    expect(() => generateAgentIdentity('')).toThrow('endpoint must be a non-empty string');
  });

  it('throws OphirError on FTP protocol', () => {
    expect(() => generateAgentIdentity('ftp://files.example.com')).toThrow(OphirError);
    expect(() => generateAgentIdentity('ftp://files.example.com')).toThrow(
      'endpoint must use http or https protocol',
    );
  });

  it('throws on non-string input (null)', () => {
    expect(() => generateAgentIdentity(null as unknown as string)).toThrow(
      'endpoint must be a non-empty string',
    );
  });

  it('two calls produce different identities', () => {
    const id1 = generateAgentIdentity('https://agent1.example.com');
    const id2 = generateAgentIdentity('https://agent2.example.com');
    expect(id1.agentId).not.toBe(id2.agentId);
    expect(Buffer.from(id1.keypair.publicKey)).not.toEqual(Buffer.from(id2.keypair.publicKey));
  });
});

describe('full roundtrip', () => {
  it('generate keypair -> publicKeyToDid -> didToPublicKey -> keys match', () => {
    const kp = generateKeyPair();
    const did = publicKeyToDid(kp.publicKey);
    const recovered = didToPublicKey(did);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(kp.publicKey));
  });

  it('roundtrip preserves all-zero key', () => {
    const zeroKey = new Uint8Array(32);
    const did = publicKeyToDid(zeroKey);
    const recovered = didToPublicKey(did);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(zeroKey));
  });

  it('roundtrip preserves all-ones key (0xFF bytes)', () => {
    const onesKey = new Uint8Array(32).fill(0xff);
    const did = publicKeyToDid(onesKey);
    const recovered = didToPublicKey(did);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(onesKey));
  });

  it('generateAgentIdentity roundtrip through DID', () => {
    const identity = generateAgentIdentity('https://test.example.com');
    const recovered = didToPublicKey(identity.agentId);
    const rederivedDid = publicKeyToDid(recovered);
    expect(rederivedDid).toBe(identity.agentId);
  });
});
