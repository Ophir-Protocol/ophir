import { describe, it, expect } from 'vitest';
import { METHODS, METHOD_LIST, isOphirMethod } from '../methods.js';
import type { OphirMethod } from '../methods.js';

describe('METHODS', () => {
  it('defines all 6 negotiation methods', () => {
    expect(Object.keys(METHODS)).toHaveLength(6);
  });

  it('RFQ is negotiate/rfq', () => {
    expect(METHODS.RFQ).toBe('negotiate/rfq');
  });

  it('QUOTE is negotiate/quote', () => {
    expect(METHODS.QUOTE).toBe('negotiate/quote');
  });

  it('COUNTER is negotiate/counter', () => {
    expect(METHODS.COUNTER).toBe('negotiate/counter');
  });

  it('ACCEPT is negotiate/accept', () => {
    expect(METHODS.ACCEPT).toBe('negotiate/accept');
  });

  it('REJECT is negotiate/reject', () => {
    expect(METHODS.REJECT).toBe('negotiate/reject');
  });

  it('DISPUTE is negotiate/dispute', () => {
    expect(METHODS.DISPUTE).toBe('negotiate/dispute');
  });

  it('all methods start with negotiate/', () => {
    for (const method of Object.values(METHODS)) {
      expect(method).toMatch(/^negotiate\//);
    }
  });
});

describe('METHOD_LIST', () => {
  it('contains all 6 methods', () => {
    expect(METHOD_LIST).toHaveLength(6);
  });

  it('matches METHODS object values', () => {
    const values = Object.values(METHODS);
    for (const method of METHOD_LIST) {
      expect(values).toContain(method);
    }
  });

  it('contains no duplicates', () => {
    const unique = new Set(METHOD_LIST);
    expect(unique.size).toBe(METHOD_LIST.length);
  });
});

describe('isOphirMethod', () => {
  it('returns true for all 6 valid methods', () => {
    expect(isOphirMethod('negotiate/rfq')).toBe(true);
    expect(isOphirMethod('negotiate/quote')).toBe(true);
    expect(isOphirMethod('negotiate/counter')).toBe(true);
    expect(isOphirMethod('negotiate/accept')).toBe(true);
    expect(isOphirMethod('negotiate/reject')).toBe(true);
    expect(isOphirMethod('negotiate/dispute')).toBe(true);
  });

  it('returns false for invalid methods', () => {
    expect(isOphirMethod('negotiate/invalid')).toBe(false);
    expect(isOphirMethod('rfq')).toBe(false);
    expect(isOphirMethod('')).toBe(false);
    expect(isOphirMethod('negotiate')).toBe(false);
    expect(isOphirMethod('negotiate/')).toBe(false);
  });

  it('returns false for methods with wrong case', () => {
    expect(isOphirMethod('negotiate/RFQ')).toBe(false);
    expect(isOphirMethod('Negotiate/rfq')).toBe(false);
  });

  it('acts as a type guard', () => {
    const method: string = 'negotiate/rfq';
    if (isOphirMethod(method)) {
      const _typed: OphirMethod = method;
      expect(_typed).toBe('negotiate/rfq');
    }
  });
});
