/**
 * Error codes mapping to specific Ophir protocol failure modes.
 *
 * Organized by category:
 * - OPHIR_001–006: Message validation errors
 * - OPHIR_100–104: Negotiation errors
 * - OPHIR_200–204: Escrow errors
 * - OPHIR_300–301: Dispute errors
 * - OPHIR_400–402: Infrastructure errors
 */
export enum OphirErrorCode {
  /** Thrown when a received message fails JSON schema or Zod validation (e.g. missing required field, wrong type). */
  INVALID_MESSAGE = 'OPHIR_001',
  /** Thrown when Ed25519 signature verification fails — message may have been tampered with. */
  INVALID_SIGNATURE = 'OPHIR_002',
  /** Thrown when a message has passed its expires_at timestamp and is no longer valid. */
  EXPIRED_MESSAGE = 'OPHIR_003',
  /** Thrown when the requested action is not valid from the current negotiation state. */
  INVALID_STATE_TRANSITION = 'OPHIR_004',
  /** Thrown when the maximum number of counter-offer rounds has been exceeded. */
  MAX_ROUNDS_EXCEEDED = 'OPHIR_005',
  /** Thrown when a message with an already-processed ID is received, indicating a potential replay attack. */
  DUPLICATE_MESSAGE = 'OPHIR_006',

  /** Thrown when no sellers match the requested service category or requirements. */
  NO_MATCHING_SELLERS = 'OPHIR_100',
  /** Thrown when the proposed price exceeds the buyer's budget constraint. */
  BUDGET_EXCEEDED = 'OPHIR_101',
  /** Thrown when the seller's SLA offer does not meet the buyer's minimum requirements. */
  SLA_REQUIREMENTS_NOT_MET = 'OPHIR_102',
  /** Thrown when a quote has passed its expiration timestamp. */
  QUOTE_EXPIRED = 'OPHIR_103',
  /** Thrown when the negotiation times out waiting for a response. */
  NEGOTIATION_TIMEOUT = 'OPHIR_104',

  /** Thrown when the Solana escrow account cannot be created (e.g. insufficient SOL for rent). */
  ESCROW_CREATION_FAILED = 'OPHIR_200',
  /** Thrown when the buyer's token account has insufficient USDC for the required deposit. */
  ESCROW_INSUFFICIENT_FUNDS = 'OPHIR_201',
  /** Thrown when the escrow has already been released and cannot be modified. */
  ESCROW_ALREADY_RELEASED = 'OPHIR_202',
  /** Thrown when escrow cancellation is attempted before the timeout slot has been reached. */
  ESCROW_TIMEOUT_NOT_REACHED = 'OPHIR_203',
  /** Thrown when escrow verification fails (e.g. PDA mismatch, wrong authority). */
  ESCROW_VERIFICATION_FAILED = 'OPHIR_204',

  /** Thrown when dispute evidence is invalid or insufficient (e.g. missing evidence hash). */
  DISPUTE_INVALID_EVIDENCE = 'OPHIR_300',
  /** Thrown when a dispute has already been resolved and cannot be re-filed. */
  DISPUTE_ALREADY_RESOLVED = 'OPHIR_301',

  /** Thrown when the seller's endpoint cannot be reached (network error or timeout). */
  SELLER_UNREACHABLE = 'OPHIR_400',
  /** Thrown when a Solana RPC request fails (e.g. connection error, rate limit). */
  SOLANA_RPC_ERROR = 'OPHIR_401',
  /** Thrown when the Lockstep verification service cannot be reached. */
  LOCKSTEP_UNREACHABLE = 'OPHIR_402',
  /** Thrown when a non-TLS endpoint is used in production (potential MITM). */
  INSECURE_TRANSPORT = 'OPHIR_403',

  /** Thrown when the clearinghouse margin assessment fails. */
  MARGIN_ASSESSMENT_FAILED = 'OPHIR_500',
  /** Thrown when an agent's exposure exceeds the clearinghouse limit. */
  EXPOSURE_LIMIT_EXCEEDED = 'OPHIR_501',
  /** Thrown when the multilateral netting cycle fails to execute. */
  NETTING_CYCLE_FAILED = 'OPHIR_502',
  /** Thrown when the circuit breaker triggers due to excessive agent exposure. */
  CIRCUIT_BREAKER_TRIGGERED = 'OPHIR_503',
  /** Thrown when the agent's Probability of Delivery score is too low. */
  POD_SCORE_INSUFFICIENT = 'OPHIR_504',
}

/** Human-readable descriptions for each Ophir error code. */
export const ERROR_DESCRIPTIONS: Record<OphirErrorCode, string> = {
  [OphirErrorCode.INVALID_MESSAGE]: 'Message failed schema validation',
  [OphirErrorCode.INVALID_SIGNATURE]: 'Ed25519 signature verification failed',
  [OphirErrorCode.EXPIRED_MESSAGE]: 'Message has expired',
  [OphirErrorCode.INVALID_STATE_TRANSITION]: 'Invalid state transition',
  [OphirErrorCode.MAX_ROUNDS_EXCEEDED]: 'Maximum negotiation rounds exceeded',
  [OphirErrorCode.DUPLICATE_MESSAGE]: 'Duplicate message ID detected (potential replay)',
  [OphirErrorCode.NO_MATCHING_SELLERS]: 'No matching sellers found',
  [OphirErrorCode.BUDGET_EXCEEDED]: 'Budget constraint exceeded',
  [OphirErrorCode.SLA_REQUIREMENTS_NOT_MET]: 'SLA requirements not met',
  [OphirErrorCode.QUOTE_EXPIRED]: 'Quote has expired',
  [OphirErrorCode.NEGOTIATION_TIMEOUT]: 'Negotiation timed out',
  [OphirErrorCode.ESCROW_CREATION_FAILED]: 'Escrow creation failed',
  [OphirErrorCode.ESCROW_INSUFFICIENT_FUNDS]: 'Insufficient funds for escrow',
  [OphirErrorCode.ESCROW_ALREADY_RELEASED]: 'Escrow already released',
  [OphirErrorCode.ESCROW_TIMEOUT_NOT_REACHED]: 'Escrow timeout not reached',
  [OphirErrorCode.ESCROW_VERIFICATION_FAILED]: 'Escrow verification failed',
  [OphirErrorCode.DISPUTE_INVALID_EVIDENCE]: 'Invalid dispute evidence',
  [OphirErrorCode.DISPUTE_ALREADY_RESOLVED]: 'Dispute already resolved',
  [OphirErrorCode.SELLER_UNREACHABLE]: 'Seller endpoint unreachable',
  [OphirErrorCode.SOLANA_RPC_ERROR]: 'Solana RPC error',
  [OphirErrorCode.LOCKSTEP_UNREACHABLE]: 'Lockstep service unreachable',
  [OphirErrorCode.INSECURE_TRANSPORT]: 'Insecure transport: TLS required',
  [OphirErrorCode.MARGIN_ASSESSMENT_FAILED]: 'Margin assessment failed',
  [OphirErrorCode.EXPOSURE_LIMIT_EXCEEDED]: 'Agent exposure limit exceeded',
  [OphirErrorCode.NETTING_CYCLE_FAILED]: 'Netting cycle execution failed',
  [OphirErrorCode.CIRCUIT_BREAKER_TRIGGERED]: 'Circuit breaker triggered — agent exposure too high',
  [OphirErrorCode.POD_SCORE_INSUFFICIENT]: 'PoD score insufficient for this operation',
};

/**
 * Typed error with an {@link OphirErrorCode} for programmatic error handling.
 *
 * @example
 * ```typescript
 * throw new OphirError(
 *   OphirErrorCode.INVALID_SIGNATURE,
 *   `Signature verification failed for agent ${agentId}`,
 *   { agentId, messageType: 'quote' },
 * );
 * ```
 */
export class OphirError extends Error {
  /** Machine-readable error code for programmatic handling. */
  readonly code: OphirErrorCode;
  /** Optional structured data providing additional context about the error. */
  readonly data?: Record<string, unknown>;

  constructor(code: OphirErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'OphirError';
    this.code = code;
    this.data = data;
  }

  /** Serialize to a plain object for JSON-RPC error responses and logging. */
  toJSON(): { code: string; message: string; data?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.data ? { data: this.data } : {}),
    };
  }

  /** Create an OphirError from just an error code, using its default description. */
  static fromCode(code: OphirErrorCode, data?: Record<string, unknown>): OphirError {
    return new OphirError(code, ERROR_DESCRIPTIONS[code] ?? code, data);
  }
}
