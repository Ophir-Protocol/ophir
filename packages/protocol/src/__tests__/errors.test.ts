import { describe, it, expect } from 'vitest';
import { OphirError, OphirErrorCode, ERROR_DESCRIPTIONS } from '../errors.js';

describe('OphirErrorCode', () => {
  it('defines all 21 error codes', () => {
    const codes = Object.values(OphirErrorCode);
    expect(codes.length).toBe(21);
  });

  it('message validation codes start with OPHIR_00', () => {
    expect(OphirErrorCode.INVALID_MESSAGE).toBe('OPHIR_001');
    expect(OphirErrorCode.INVALID_SIGNATURE).toBe('OPHIR_002');
    expect(OphirErrorCode.EXPIRED_MESSAGE).toBe('OPHIR_003');
    expect(OphirErrorCode.INVALID_STATE_TRANSITION).toBe('OPHIR_004');
    expect(OphirErrorCode.MAX_ROUNDS_EXCEEDED).toBe('OPHIR_005');
    expect(OphirErrorCode.DUPLICATE_MESSAGE).toBe('OPHIR_006');
  });

  it('negotiation codes start with OPHIR_1', () => {
    expect(OphirErrorCode.NO_MATCHING_SELLERS).toBe('OPHIR_100');
    expect(OphirErrorCode.BUDGET_EXCEEDED).toBe('OPHIR_101');
    expect(OphirErrorCode.SLA_REQUIREMENTS_NOT_MET).toBe('OPHIR_102');
    expect(OphirErrorCode.QUOTE_EXPIRED).toBe('OPHIR_103');
    expect(OphirErrorCode.NEGOTIATION_TIMEOUT).toBe('OPHIR_104');
  });

  it('escrow codes start with OPHIR_2', () => {
    expect(OphirErrorCode.ESCROW_CREATION_FAILED).toBe('OPHIR_200');
    expect(OphirErrorCode.ESCROW_INSUFFICIENT_FUNDS).toBe('OPHIR_201');
    expect(OphirErrorCode.ESCROW_ALREADY_RELEASED).toBe('OPHIR_202');
    expect(OphirErrorCode.ESCROW_TIMEOUT_NOT_REACHED).toBe('OPHIR_203');
    expect(OphirErrorCode.ESCROW_VERIFICATION_FAILED).toBe('OPHIR_204');
  });

  it('dispute codes start with OPHIR_3', () => {
    expect(OphirErrorCode.DISPUTE_INVALID_EVIDENCE).toBe('OPHIR_300');
    expect(OphirErrorCode.DISPUTE_ALREADY_RESOLVED).toBe('OPHIR_301');
  });

  it('infrastructure codes start with OPHIR_4', () => {
    expect(OphirErrorCode.SELLER_UNREACHABLE).toBe('OPHIR_400');
    expect(OphirErrorCode.SOLANA_RPC_ERROR).toBe('OPHIR_401');
    expect(OphirErrorCode.LOCKSTEP_UNREACHABLE).toBe('OPHIR_402');
  });

  it('all codes are unique', () => {
    const codes = Object.values(OphirErrorCode);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

describe('ERROR_DESCRIPTIONS', () => {
  it('has a description for every error code', () => {
    for (const code of Object.values(OphirErrorCode)) {
      expect(ERROR_DESCRIPTIONS[code]).toBeDefined();
      expect(typeof ERROR_DESCRIPTIONS[code]).toBe('string');
      expect(ERROR_DESCRIPTIONS[code].length).toBeGreaterThan(0);
    }
  });
});

describe('OphirError', () => {
  it('is an instance of Error', () => {
    const err = new OphirError(OphirErrorCode.INVALID_MESSAGE, 'test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OphirError);
  });

  it('sets name to OphirError', () => {
    const err = new OphirError(OphirErrorCode.INVALID_MESSAGE, 'test');
    expect(err.name).toBe('OphirError');
  });

  it('stores code and message', () => {
    const err = new OphirError(OphirErrorCode.INVALID_SIGNATURE, 'bad sig');
    expect(err.code).toBe(OphirErrorCode.INVALID_SIGNATURE);
    expect(err.message).toBe('bad sig');
  });

  it('stores optional data', () => {
    const data = { agentId: 'did:key:test', field: 'signature' };
    const err = new OphirError(OphirErrorCode.INVALID_SIGNATURE, 'bad sig', data);
    expect(err.data).toEqual(data);
  });

  it('data is undefined when not provided', () => {
    const err = new OphirError(OphirErrorCode.INVALID_MESSAGE, 'test');
    expect(err.data).toBeUndefined();
  });

  describe('toJSON', () => {
    it('serializes code and message', () => {
      const err = new OphirError(OphirErrorCode.EXPIRED_MESSAGE, 'expired');
      const json = err.toJSON();
      expect(json.code).toBe('OPHIR_003');
      expect(json.message).toBe('expired');
      expect(json.data).toBeUndefined();
    });

    it('includes data when present', () => {
      const err = new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        'bad',
        { field: 'rfq_id' },
      );
      const json = err.toJSON();
      expect(json.data).toEqual({ field: 'rfq_id' });
    });
  });

  describe('fromCode', () => {
    it('creates error from code with default description', () => {
      const err = OphirError.fromCode(OphirErrorCode.INVALID_SIGNATURE);
      expect(err.code).toBe(OphirErrorCode.INVALID_SIGNATURE);
      expect(err.message).toBe('Ed25519 signature verification failed');
    });

    it('includes optional data', () => {
      const err = OphirError.fromCode(
        OphirErrorCode.SELLER_UNREACHABLE,
        { endpoint: 'http://test.com' },
      );
      expect(err.code).toBe(OphirErrorCode.SELLER_UNREACHABLE);
      expect(err.data).toEqual({ endpoint: 'http://test.com' });
    });

    it('works for all error codes', () => {
      for (const code of Object.values(OphirErrorCode)) {
        const err = OphirError.fromCode(code);
        expect(err).toBeInstanceOf(OphirError);
        expect(err.code).toBe(code);
        expect(err.message.length).toBeGreaterThan(0);
      }
    });
  });
});
