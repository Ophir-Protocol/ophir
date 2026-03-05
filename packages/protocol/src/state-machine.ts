/**
 * Negotiation state machine transition rules.
 *
 * Defines the valid transitions between negotiation states and provides
 * a validation function to enforce them. This is the canonical source
 * of truth for the protocol's state machine — all implementations
 * (SDK, server, off-chain verifiers) must respect these rules.
 *
 * ## State Diagram
 *
 * ```
 * IDLE ──> RFQ_SENT ──> QUOTES_RECEIVED ──> COUNTERING
 *                  \          |    \             |   \
 *                   \         |     \            |    \
 *                    v        v      v           v     v
 *                  REJECTED  ACCEPTED  REJECTED  ACCEPTED  REJECTED
 *                               |
 *                               v
 *                           ESCROWED ──> ACTIVE ──> COMPLETED
 *                                           |
 *                                           v
 *                                       DISPUTED ──> RESOLVED
 * ```
 *
 * Terminal states: COMPLETED, REJECTED, RESOLVED
 */
import type { NegotiationState } from './types.js';

/**
 * Map of valid state transitions. Each key is a current state; the value
 * is the set of states that can be reached from it.
 *
 * This map encodes the full negotiation lifecycle:
 * - IDLE → RFQ_SENT: buyer sends an RFQ
 * - RFQ_SENT → QUOTES_RECEIVED | REJECTED: seller quotes or buyer/seller rejects
 * - QUOTES_RECEIVED → COUNTERING | ACCEPTED | REJECTED: counter, accept, or reject
 * - COUNTERING → COUNTERING | ACCEPTED | REJECTED: another round, accept, or reject
 * - ACCEPTED → ESCROWED | REJECTED: fund escrow or refuse to counter-sign
 * - ESCROWED → ACTIVE: service delivery begins
 * - ACTIVE → COMPLETED | DISPUTED: success or SLA violation
 * - DISPUTED → RESOLVED: dispute adjudicated
 * - COMPLETED, REJECTED, RESOLVED are terminal (no outgoing transitions)
 */
export const VALID_TRANSITIONS: Readonly<Record<NegotiationState, readonly NegotiationState[]>> = {
  IDLE: ['RFQ_SENT'],
  RFQ_SENT: ['QUOTES_RECEIVED', 'REJECTED'],
  QUOTES_RECEIVED: ['COUNTERING', 'ACCEPTED', 'REJECTED'],
  COUNTERING: ['COUNTERING', 'ACCEPTED', 'REJECTED'],
  ACCEPTED: ['ESCROWED', 'REJECTED'],
  ESCROWED: ['ACTIVE'],
  ACTIVE: ['COMPLETED', 'DISPUTED'],
  COMPLETED: [],
  REJECTED: [],
  DISPUTED: ['RESOLVED'],
  RESOLVED: [],
} as const;

/** Terminal states that have no valid outgoing transitions. */
export const TERMINAL_STATES: readonly NegotiationState[] = [
  'COMPLETED',
  'REJECTED',
  'RESOLVED',
] as const;

/**
 * Check whether a state transition is valid according to the protocol.
 *
 * @param from - The current negotiation state.
 * @param to - The proposed next state.
 * @returns `true` if the transition is allowed, `false` otherwise.
 *
 * @example
 * ```typescript
 * isValidTransition('IDLE', 'RFQ_SENT');        // true
 * isValidTransition('IDLE', 'COMPLETED');        // false
 * isValidTransition('COMPLETED', 'ACTIVE');      // false (terminal)
 * ```
 */
export function isValidTransition(from: NegotiationState, to: NegotiationState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/**
 * Check whether a state is terminal (no outgoing transitions).
 *
 * @param state - The state to check.
 * @returns `true` if the state is terminal.
 *
 * @example
 * ```typescript
 * isTerminalState('COMPLETED'); // true
 * isTerminalState('ACTIVE');    // false
 * ```
 */
export function isTerminalState(state: NegotiationState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Get all states reachable from a given state.
 *
 * @param from - The current state.
 * @returns Read-only array of valid next states (empty for terminal states).
 *
 * @example
 * ```typescript
 * getValidNextStates('ACTIVE'); // ['COMPLETED', 'DISPUTED']
 * getValidNextStates('COMPLETED'); // []
 * ```
 */
export function getValidNextStates(from: NegotiationState): readonly NegotiationState[] {
  return VALID_TRANSITIONS[from] ?? [];
}
