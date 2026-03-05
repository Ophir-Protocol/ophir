import type {
  NegotiationState,
  RFQParams,
  QuoteParams,
  CounterParams,
} from '@ophirai/protocol';
import { OphirError, OphirErrorCode, DEFAULT_CONFIG, isValidTransition, isTerminalState, getValidNextStates } from '@ophirai/protocol';
import type { Agreement } from './types.js';

const DEFAULT_TIMEOUTS: Partial<Record<NegotiationState, number>> = {
  RFQ_SENT: DEFAULT_CONFIG.rfq_timeout_ms,
  QUOTES_RECEIVED: DEFAULT_CONFIG.quote_timeout_ms,
  COUNTERING: DEFAULT_CONFIG.counter_timeout_ms,
};

/**
 * Tracks the state of a single negotiation from RFQ through completion or rejection.
 *
 * All state transitions are validated against the protocol's canonical state machine
 * defined in `@ophirai/protocol` using `isValidTransition()`. Invalid transitions
 * throw `OphirError` with code `INVALID_STATE_TRANSITION`.
 */
export class NegotiationSession {
  readonly rfqId: string;
  state: NegotiationState;
  readonly rfq: RFQParams;
  quotes: QuoteParams[] = [];
  counters: CounterParams[] = [];
  agreement?: Agreement;
  rejectionReason?: string;
  currentRound = 0;
  maxRounds: number;
  createdAt: Date;
  updatedAt: Date;
  timeouts: Map<NegotiationState, number>;
  private escrowAddress?: string;

  constructor(rfq: RFQParams, maxRounds?: number) {
    this.rfqId = rfq.rfq_id;
    this.rfq = rfq;
    this.state = 'RFQ_SENT';
    this.maxRounds = maxRounds ?? rfq.max_rounds ?? DEFAULT_CONFIG.max_negotiation_rounds;
    this.createdAt = new Date();
    this.updatedAt = new Date();

    this.timeouts = new Map<NegotiationState, number>();
    for (const [state, ms] of Object.entries(DEFAULT_TIMEOUTS)) {
      this.timeouts.set(state as NegotiationState, ms as number);
    }
  }

  /** Add a received quote to this session and transition state to QUOTES_RECEIVED.
   *
   * Can be called from RFQ_SENT (first quote triggers transition),
   * QUOTES_RECEIVED (additional quotes accumulate without re-transitioning),
   * or COUNTERING (seller's response quote during counter-offer flow).
   *
   * @param quote - The quote parameters received from a seller agent
   * @throws {OphirError} When the session is not in a state that accepts quotes
   */
  addQuote(quote: QuoteParams): void {
    // Allow accumulating quotes while already in QUOTES_RECEIVED (same-state is a no-op transition)
    if (this.state === 'QUOTES_RECEIVED') {
      this.quotes.push(quote);
      this.updatedAt = new Date();
      return;
    }
    // During countering, a seller's response quote is part of the counter-offer flow.
    // Accumulate it without changing state (COUNTERING → COUNTERING is valid).
    if (this.state === 'COUNTERING') {
      this.quotes.push(quote);
      this.updatedAt = new Date();
      return;
    }
    this.enforceTransition('QUOTES_RECEIVED', 'addQuote');
    this.quotes.push(quote);
    this.applyTransition('QUOTES_RECEIVED');
  }

  /** Add a counter-offer and increment the negotiation round.
   * @param counter - The counter-offer parameters
   * @throws {OphirError} When the transition from the current state to COUNTERING is not valid
   * @throws {OphirError} When the current round exceeds the maximum allowed rounds
   * @example
   * ```typescript
   * session.addCounter({ rfq_id: 'rfq_1', counter_id: 'ctr_1', ...terms });
   * ```
   */
  addCounter(counter: CounterParams): void {
    this.enforceTransition('COUNTERING', 'addCounter');
    this.currentRound++;
    if (this.currentRound > this.maxRounds) {
      throw new OphirError(
        OphirErrorCode.MAX_ROUNDS_EXCEEDED,
        `Round ${this.currentRound} exceeds max ${this.maxRounds}`,
      );
    }
    this.counters.push(counter);
    this.applyTransition('COUNTERING');
  }

  /** Accept the negotiation with a finalized agreement and transition to ACCEPTED.
   * @param agreement - The finalized agreement terms both parties have agreed upon
   * @throws {OphirError} When the transition from the current state to ACCEPTED is not valid
   * @example
   * ```typescript
   * session.accept({ agreement_id: 'agr_1', terms, sla, payment });
   * ```
   */
  accept(agreement: Agreement): void {
    this.enforceTransition('ACCEPTED', 'accept');
    this.agreement = agreement;
    this.applyTransition('ACCEPTED');
  }

  /** Reject the negotiation with a human-readable reason and transition to REJECTED.
   *
   * Valid from: RFQ_SENT, QUOTES_RECEIVED, COUNTERING, ACCEPTED (per protocol spec).
   * @param reason - Human-readable explanation for why the negotiation was rejected
   * @throws {OphirError} When the transition from the current state to REJECTED is not valid
   */
  reject(reason: string): void {
    this.enforceTransition('REJECTED', 'reject');
    this.rejectionReason = reason;
    this.applyTransition('REJECTED');
  }

  /** Record that escrow has been funded on-chain and transition to ESCROWED.
   * @param escrowAddress - The on-chain address where escrow funds are held
   * @throws {OphirError} When the transition from the current state to ESCROWED is not valid
   */
  escrowFunded(escrowAddress: string): void {
    this.enforceTransition('ESCROWED', 'escrowFunded');
    this.escrowAddress = escrowAddress;
    this.applyTransition('ESCROWED');
  }

  /** Activate the agreement so the seller begins service delivery.
   * @throws {OphirError} When the transition from the current state to ACTIVE is not valid
   */
  activate(): void {
    this.enforceTransition('ACTIVE', 'activate');
    this.applyTransition('ACTIVE');
  }

  /** Mark the agreement as successfully completed and transition to COMPLETED.
   * @throws {OphirError} When the transition from the current state to COMPLETED is not valid
   */
  complete(): void {
    this.enforceTransition('COMPLETED', 'complete');
    this.applyTransition('COMPLETED');
  }

  /** Transition to DISPUTED state to claim an SLA violation.
   * @throws {OphirError} When the transition from the current state to DISPUTED is not valid
   */
  dispute(): void {
    this.enforceTransition('DISPUTED', 'dispute');
    this.applyTransition('DISPUTED');
  }

  /** Mark a dispute as resolved and transition to RESOLVED.
   * @throws {OphirError} When the transition from the current state to RESOLVED is not valid
   */
  resolve(): void {
    this.enforceTransition('RESOLVED', 'resolve');
    this.applyTransition('RESOLVED');
  }

  /** Get the on-chain escrow address, if set.
   * @returns The escrow address, or undefined if escrow has not been funded
   */
  getEscrowAddress(): string | undefined {
    return this.escrowAddress;
  }

  /** Check if the current state has exceeded its configured timeout.
   * @returns True if the time elapsed since the last transition exceeds the state timeout
   */
  isExpired(): boolean {
    const timeout = this.timeouts.get(this.state);
    if (timeout === undefined) return false;
    return Date.now() - this.updatedAt.getTime() > timeout;
  }

  /** Check if the session is in a terminal state (COMPLETED, REJECTED, or RESOLVED).
   * @returns True if the session has reached a terminal state
   */
  isTerminal(): boolean {
    return isTerminalState(this.state);
  }

  /** Get the set of valid next states from the current state.
   * @returns Read-only array of states that can be transitioned to
   */
  getValidNextStates(): readonly NegotiationState[] {
    return getValidNextStates(this.state);
  }

  /** Serialize session state to a plain object for logging or persistence.
   * @returns A plain object containing all session fields with dates as ISO strings
   */
  toJSON(): Record<string, unknown> {
    return {
      rfqId: this.rfqId,
      state: this.state,
      rfq: this.rfq,
      quotes: this.quotes,
      counters: this.counters,
      agreement: this.agreement,
      rejectionReason: this.rejectionReason,
      currentRound: this.currentRound,
      maxRounds: this.maxRounds,
      escrowAddress: this.escrowAddress,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  /**
   * Validate a state transition against the protocol's canonical state machine.
   * Uses `isValidTransition()` from `@ophirai/protocol` as the single source of truth.
   *
   * @param targetState - The state to transition to
   * @param action - The action name for error messages
   * @throws {OphirError} INVALID_STATE_TRANSITION if the transition is not allowed
   */
  private enforceTransition(targetState: NegotiationState, action: string): void {
    if (isTerminalState(this.state)) {
      throw new OphirError(
        OphirErrorCode.INVALID_STATE_TRANSITION,
        `Cannot ${action}: session is in terminal state ${this.state}`,
        { currentState: this.state, targetState },
      );
    }
    if (!isValidTransition(this.state, targetState)) {
      const validNext = getValidNextStates(this.state);
      throw new OphirError(
        OphirErrorCode.INVALID_STATE_TRANSITION,
        `Cannot ${action} from state ${this.state}. Valid transitions: ${validNext.join(', ')}`,
        { currentState: this.state, targetState, validTransitions: [...validNext] },
      );
    }
  }

  /** Apply a validated state transition. */
  private applyTransition(to: NegotiationState): void {
    this.state = to;
    this.updatedAt = new Date();
  }
}
