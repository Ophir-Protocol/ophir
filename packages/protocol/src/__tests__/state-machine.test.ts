import { describe, it, expect } from 'vitest';
import {
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  isValidTransition,
  isTerminalState,
  getValidNextStates,
} from '../state-machine.js';
import type { NegotiationState } from '../types.js';

const ALL_STATES: NegotiationState[] = [
  'IDLE', 'RFQ_SENT', 'QUOTES_RECEIVED', 'COUNTERING',
  'ACCEPTED', 'ESCROWED', 'ACTIVE', 'COMPLETED',
  'REJECTED', 'DISPUTED', 'RESOLVED',
];

describe('VALID_TRANSITIONS', () => {
  it('defines transitions for all 11 states', () => {
    expect(Object.keys(VALID_TRANSITIONS)).toHaveLength(11);
    for (const state of ALL_STATES) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
    }
  });

  it('IDLE can only transition to RFQ_SENT', () => {
    expect(VALID_TRANSITIONS.IDLE).toEqual(['RFQ_SENT']);
  });

  it('RFQ_SENT can transition to QUOTES_RECEIVED or REJECTED', () => {
    expect(VALID_TRANSITIONS.RFQ_SENT).toEqual(['QUOTES_RECEIVED', 'REJECTED']);
  });

  it('QUOTES_RECEIVED can transition to COUNTERING, ACCEPTED, or REJECTED', () => {
    expect(VALID_TRANSITIONS.QUOTES_RECEIVED).toEqual(['COUNTERING', 'ACCEPTED', 'REJECTED']);
  });

  it('COUNTERING can transition to COUNTERING, ACCEPTED, or REJECTED', () => {
    expect(VALID_TRANSITIONS.COUNTERING).toEqual(['COUNTERING', 'ACCEPTED', 'REJECTED']);
  });

  it('ACCEPTED can transition to ESCROWED or REJECTED', () => {
    expect(VALID_TRANSITIONS.ACCEPTED).toEqual(['ESCROWED', 'REJECTED']);
  });

  it('ESCROWED can only transition to ACTIVE', () => {
    expect(VALID_TRANSITIONS.ESCROWED).toEqual(['ACTIVE']);
  });

  it('ACTIVE can transition to COMPLETED or DISPUTED', () => {
    expect(VALID_TRANSITIONS.ACTIVE).toEqual(['COMPLETED', 'DISPUTED']);
  });

  it('DISPUTED can only transition to RESOLVED', () => {
    expect(VALID_TRANSITIONS.DISPUTED).toEqual(['RESOLVED']);
  });

  it('COMPLETED has no outgoing transitions', () => {
    expect(VALID_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it('REJECTED has no outgoing transitions', () => {
    expect(VALID_TRANSITIONS.REJECTED).toEqual([]);
  });

  it('RESOLVED has no outgoing transitions', () => {
    expect(VALID_TRANSITIONS.RESOLVED).toEqual([]);
  });
});

describe('TERMINAL_STATES', () => {
  it('contains exactly COMPLETED, REJECTED, RESOLVED', () => {
    expect(TERMINAL_STATES).toEqual(['COMPLETED', 'REJECTED', 'RESOLVED']);
  });

  it('all terminal states have empty transition arrays', () => {
    for (const state of TERMINAL_STATES) {
      expect(VALID_TRANSITIONS[state]).toEqual([]);
    }
  });
});

describe('isValidTransition', () => {
  it('accepts IDLE → RFQ_SENT', () => {
    expect(isValidTransition('IDLE', 'RFQ_SENT')).toBe(true);
  });

  it('rejects IDLE → COMPLETED', () => {
    expect(isValidTransition('IDLE', 'COMPLETED')).toBe(false);
  });

  it('rejects IDLE → ACTIVE', () => {
    expect(isValidTransition('IDLE', 'ACTIVE')).toBe(false);
  });

  it('accepts RFQ_SENT → QUOTES_RECEIVED', () => {
    expect(isValidTransition('RFQ_SENT', 'QUOTES_RECEIVED')).toBe(true);
  });

  it('accepts RFQ_SENT → REJECTED', () => {
    expect(isValidTransition('RFQ_SENT', 'REJECTED')).toBe(true);
  });

  it('rejects RFQ_SENT → ACCEPTED', () => {
    expect(isValidTransition('RFQ_SENT', 'ACCEPTED')).toBe(false);
  });

  it('accepts QUOTES_RECEIVED → COUNTERING', () => {
    expect(isValidTransition('QUOTES_RECEIVED', 'COUNTERING')).toBe(true);
  });

  it('accepts QUOTES_RECEIVED → ACCEPTED', () => {
    expect(isValidTransition('QUOTES_RECEIVED', 'ACCEPTED')).toBe(true);
  });

  it('accepts QUOTES_RECEIVED → REJECTED', () => {
    expect(isValidTransition('QUOTES_RECEIVED', 'REJECTED')).toBe(true);
  });

  it('rejects QUOTES_RECEIVED → ESCROWED', () => {
    expect(isValidTransition('QUOTES_RECEIVED', 'ESCROWED')).toBe(false);
  });

  it('allows COUNTERING → COUNTERING (self-loop for multi-round)', () => {
    expect(isValidTransition('COUNTERING', 'COUNTERING')).toBe(true);
  });

  it('accepts COUNTERING → ACCEPTED', () => {
    expect(isValidTransition('COUNTERING', 'ACCEPTED')).toBe(true);
  });

  it('accepts COUNTERING → REJECTED', () => {
    expect(isValidTransition('COUNTERING', 'REJECTED')).toBe(true);
  });

  it('rejects COUNTERING → IDLE', () => {
    expect(isValidTransition('COUNTERING', 'IDLE')).toBe(false);
  });

  it('accepts ACCEPTED → ESCROWED', () => {
    expect(isValidTransition('ACCEPTED', 'ESCROWED')).toBe(true);
  });

  it('accepts ACCEPTED → REJECTED', () => {
    expect(isValidTransition('ACCEPTED', 'REJECTED')).toBe(true);
  });

  it('rejects ACCEPTED → ACTIVE', () => {
    expect(isValidTransition('ACCEPTED', 'ACTIVE')).toBe(false);
  });

  it('accepts ESCROWED → ACTIVE', () => {
    expect(isValidTransition('ESCROWED', 'ACTIVE')).toBe(true);
  });

  it('rejects ESCROWED → COMPLETED', () => {
    expect(isValidTransition('ESCROWED', 'COMPLETED')).toBe(false);
  });

  it('accepts ACTIVE → COMPLETED', () => {
    expect(isValidTransition('ACTIVE', 'COMPLETED')).toBe(true);
  });

  it('accepts ACTIVE → DISPUTED', () => {
    expect(isValidTransition('ACTIVE', 'DISPUTED')).toBe(true);
  });

  it('rejects ACTIVE → REJECTED', () => {
    expect(isValidTransition('ACTIVE', 'REJECTED')).toBe(false);
  });

  it('accepts DISPUTED → RESOLVED', () => {
    expect(isValidTransition('DISPUTED', 'RESOLVED')).toBe(true);
  });

  it('rejects DISPUTED → ACTIVE', () => {
    expect(isValidTransition('DISPUTED', 'ACTIVE')).toBe(false);
  });

  it('rejects all transitions from COMPLETED', () => {
    for (const state of ALL_STATES) {
      expect(isValidTransition('COMPLETED', state)).toBe(false);
    }
  });

  it('rejects all transitions from REJECTED', () => {
    for (const state of ALL_STATES) {
      expect(isValidTransition('REJECTED', state)).toBe(false);
    }
  });

  it('rejects all transitions from RESOLVED', () => {
    for (const state of ALL_STATES) {
      expect(isValidTransition('RESOLVED', state)).toBe(false);
    }
  });
});

describe('isTerminalState', () => {
  it('returns true for COMPLETED', () => {
    expect(isTerminalState('COMPLETED')).toBe(true);
  });

  it('returns true for REJECTED', () => {
    expect(isTerminalState('REJECTED')).toBe(true);
  });

  it('returns true for RESOLVED', () => {
    expect(isTerminalState('RESOLVED')).toBe(true);
  });

  it('returns false for IDLE', () => {
    expect(isTerminalState('IDLE')).toBe(false);
  });

  it('returns false for ACTIVE', () => {
    expect(isTerminalState('ACTIVE')).toBe(false);
  });

  it('returns false for all non-terminal states', () => {
    const nonTerminal: NegotiationState[] = [
      'IDLE', 'RFQ_SENT', 'QUOTES_RECEIVED', 'COUNTERING',
      'ACCEPTED', 'ESCROWED', 'ACTIVE', 'DISPUTED',
    ];
    for (const state of nonTerminal) {
      expect(isTerminalState(state)).toBe(false);
    }
  });
});

describe('getValidNextStates', () => {
  it('returns [RFQ_SENT] for IDLE', () => {
    expect(getValidNextStates('IDLE')).toEqual(['RFQ_SENT']);
  });

  it('returns empty array for terminal states', () => {
    expect(getValidNextStates('COMPLETED')).toEqual([]);
    expect(getValidNextStates('REJECTED')).toEqual([]);
    expect(getValidNextStates('RESOLVED')).toEqual([]);
  });

  it('returns [COMPLETED, DISPUTED] for ACTIVE', () => {
    expect(getValidNextStates('ACTIVE')).toEqual(['COMPLETED', 'DISPUTED']);
  });

  it('returns [RESOLVED] for DISPUTED', () => {
    expect(getValidNextStates('DISPUTED')).toEqual(['RESOLVED']);
  });
});

describe('full lifecycle transitions', () => {
  it('validates the happy path: IDLE → RFQ_SENT → QUOTES_RECEIVED → ACCEPTED → ESCROWED → ACTIVE → COMPLETED', () => {
    const path: NegotiationState[] = [
      'IDLE', 'RFQ_SENT', 'QUOTES_RECEIVED', 'ACCEPTED', 'ESCROWED', 'ACTIVE', 'COMPLETED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(isValidTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('validates the counter path: IDLE → RFQ_SENT → QUOTES_RECEIVED → COUNTERING → COUNTERING → ACCEPTED → ESCROWED → ACTIVE → COMPLETED', () => {
    const path: NegotiationState[] = [
      'IDLE', 'RFQ_SENT', 'QUOTES_RECEIVED', 'COUNTERING',
      'COUNTERING', 'ACCEPTED', 'ESCROWED', 'ACTIVE', 'COMPLETED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(isValidTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('validates the dispute path: ...ACTIVE → DISPUTED → RESOLVED', () => {
    expect(isValidTransition('ACTIVE', 'DISPUTED')).toBe(true);
    expect(isValidTransition('DISPUTED', 'RESOLVED')).toBe(true);
  });

  it('validates early rejection paths', () => {
    expect(isValidTransition('RFQ_SENT', 'REJECTED')).toBe(true);
    expect(isValidTransition('QUOTES_RECEIVED', 'REJECTED')).toBe(true);
    expect(isValidTransition('COUNTERING', 'REJECTED')).toBe(true);
    expect(isValidTransition('ACCEPTED', 'REJECTED')).toBe(true);
  });

  it('prevents skipping states', () => {
    expect(isValidTransition('IDLE', 'ACCEPTED')).toBe(false);
    expect(isValidTransition('IDLE', 'ACTIVE')).toBe(false);
    expect(isValidTransition('RFQ_SENT', 'ESCROWED')).toBe(false);
    expect(isValidTransition('QUOTES_RECEIVED', 'ACTIVE')).toBe(false);
    expect(isValidTransition('ESCROWED', 'COMPLETED')).toBe(false);
  });

  it('prevents backward transitions', () => {
    expect(isValidTransition('ACTIVE', 'ESCROWED')).toBe(false);
    expect(isValidTransition('ESCROWED', 'ACCEPTED')).toBe(false);
    expect(isValidTransition('ACCEPTED', 'QUOTES_RECEIVED')).toBe(false);
    expect(isValidTransition('QUOTES_RECEIVED', 'RFQ_SENT')).toBe(false);
    expect(isValidTransition('RFQ_SENT', 'IDLE')).toBe(false);
  });
});
