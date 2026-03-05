import { describe, it, expect } from 'vitest';
import { agreementToX402Headers, parseX402Response } from '../x402.js';
import type { Agreement } from '../types.js';

function makeAgreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    agreement_id: 'agr_x402_001',
    rfq_id: 'rfq_001',
    accepting_message_id: 'quote_001',
    final_terms: {
      price_per_unit: '0.005',
      currency: 'USDC',
      unit: 'request',
    },
    agreement_hash: 'abcdef1234567890',
    buyer_signature: 'buyer_sig',
    seller_signature: 'seller_sig',
    ...overrides,
  };
}

describe('agreementToX402Headers', () => {
  it('includes agreement ID in headers', () => {
    const agreement = makeAgreement();
    const headers = agreementToX402Headers(agreement);

    expect(headers['X-Payment-Agreement-Id']).toBe('agr_x402_001');
  });

  it('includes price, currency, unit, and agreement hash', () => {
    const agreement = makeAgreement();
    const headers = agreementToX402Headers(agreement);

    expect(headers['X-Payment-Amount']).toBe('0.005');
    expect(headers['X-Payment-Currency']).toBe('USDC');
    expect(headers['X-Payment-Unit']).toBe('request');
    expect(headers['X-Payment-Agreement-Hash']).toBe('abcdef1234567890');
  });

  it('includes escrow network and deposit when final_terms has escrow', () => {
    const agreement = makeAgreement({
      final_terms: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
        escrow: {
          network: 'solana',
          deposit_amount: '100.0',
          release_condition: 'sla_met',
        },
      },
    });
    const headers = agreementToX402Headers(agreement);

    expect(headers['X-Payment-Network']).toBe('solana');
    expect(headers['X-Payment-Escrow-Deposit']).toBe('100.0');
  });

  it('includes escrow address when agreement has escrow PDA', () => {
    const agreement = makeAgreement({
      escrow: {
        address: 'EscrowPDA_base58address',
        txSignature: 'tx_sig_123',
      },
    });
    const headers = agreementToX402Headers(agreement);

    expect(headers['X-Payment-Escrow-Address']).toBe('EscrowPDA_base58address');
  });

  it('omits escrow headers when no escrow configured', () => {
    const agreement = makeAgreement();
    const headers = agreementToX402Headers(agreement);

    expect(headers['X-Payment-Network']).toBeUndefined();
    expect(headers['X-Payment-Escrow-Deposit']).toBeUndefined();
    expect(headers['X-Payment-Escrow-Address']).toBeUndefined();
  });

  it('returns all expected header keys', () => {
    const agreement = makeAgreement({
      final_terms: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'token',
        escrow: {
          network: 'solana',
          deposit_amount: '50',
          release_condition: 'job_complete',
        },
      },
      escrow: {
        address: 'PDA_addr',
        txSignature: 'tx123',
      },
    });
    const headers = agreementToX402Headers(agreement);

    const keys = Object.keys(headers);
    expect(keys).toContain('X-Payment-Amount');
    expect(keys).toContain('X-Payment-Currency');
    expect(keys).toContain('X-Payment-Agreement-Id');
    expect(keys).toContain('X-Payment-Agreement-Hash');
    expect(keys).toContain('X-Payment-Unit');
    expect(keys).toContain('X-Payment-Network');
    expect(keys).toContain('X-Payment-Escrow-Deposit');
    expect(keys).toContain('X-Payment-Escrow-Address');
  });
});

describe('parseX402Response', () => {
  it('parses standard cased headers', () => {
    const result = parseX402Response({
      'X-Payment-Amount': '0.005',
      'X-Payment-Currency': 'USDC',
      'X-Payment-Address': 'addr_123',
    });

    expect(result.price).toBe('0.005');
    expect(result.currency).toBe('USDC');
    expect(result.paymentAddress).toBe('addr_123');
  });

  it('parses lowercase headers', () => {
    const result = parseX402Response({
      'x-payment-amount': '0.01',
      'x-payment-currency': 'SOL',
      'x-payment-address': 'sol_addr',
    });

    expect(result.price).toBe('0.01');
    expect(result.currency).toBe('SOL');
    expect(result.paymentAddress).toBe('sol_addr');
  });

  it('parses mixed-case headers', () => {
    const result = parseX402Response({
      'X-PAYMENT-AMOUNT': '1.5',
      'X-Payment-currency': 'ETH',
      'x-Payment-Address': 'eth_addr',
    });

    expect(result.price).toBe('1.5');
    expect(result.currency).toBe('ETH');
    expect(result.paymentAddress).toBe('eth_addr');
  });

  it('returns defaults when headers are missing', () => {
    const result = parseX402Response({});

    expect(result.price).toBe('0');
    expect(result.currency).toBe('USDC');
    expect(result.paymentAddress).toBe('');
  });

  it('returns partial defaults for partially present headers', () => {
    const result = parseX402Response({
      'X-Payment-Amount': '5.0',
    });

    expect(result.price).toBe('5.0');
    expect(result.currency).toBe('USDC');
    expect(result.paymentAddress).toBe('');
  });
});
