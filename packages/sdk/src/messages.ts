import { v4 as uuidv4 } from 'uuid';
import { METHODS, DEFAULT_CONFIG, OphirError, OphirErrorCode } from '@ophir/protocol';
import type {
  AgentIdentity,
  ServiceRequirement,
  BudgetConstraint,
  SLARequirement,
  PaymentMethod,
  PricingOffer,
  ExecutionInfo,
  EscrowRequirement,
  FinalTerms,
  ViolationEvidence,
  JsonRpcRequest,
  RFQParams,
  QuoteParams,
  CounterParams,
  AcceptParams,
  RejectParams,
  DisputeParams,
} from '@ophir/protocol';
import { signMessage, agreementHash } from './signing.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate that a string is non-empty. */
function requireNonEmpty(value: string, name: string): void {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      `${name} must be a non-empty string`,
    );
  }
}

/** Validate that a string looks like a UUID. */
function requireUUID(value: string, name: string): void {
  requireNonEmpty(value, name);
  if (!UUID_RE.test(value)) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      `${name} must be a valid UUID, got: ${value}`,
    );
  }
}

/** Compute an ISO 8601 expiration timestamp from a TTL in milliseconds. */
function expiresAt(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

/** Wrap params in a JSON-RPC 2.0 request envelope with a UUID id. */
function rpcEnvelope<T>(method: string, params: T): JsonRpcRequest<T> {
  return { jsonrpc: '2.0', method, id: uuidv4(), params };
}

/**
 * Build a signed RFQ (Request for Quote) message. Signs the RFQ with the buyer's Ed25519 key
 * so that sellers can verify the buyer authorized this request.
 *
 * @throws {OphirError} if buyer identity fields are missing.
 * @throws {OphirError} if secretKey is not 64 bytes.
 *
 * @example
 * ```typescript
 * const rfq = buildRFQ({
 *   buyer: { agent_id: 'did:key:z6Mk...', endpoint: 'https://buyer.example.com' },
 *   service: { category: 'inference' },
 *   budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
 *   secretKey: keypair.secretKey,
 * });
 * ```
 */
export function buildRFQ(params: {
  buyer: AgentIdentity;
  service: ServiceRequirement;
  budget: BudgetConstraint;
  sla?: SLARequirement;
  sellers?: string[];
  maxRounds?: number;
  ttlMs?: number;
  acceptedPayments?: PaymentMethod[];
  secretKey: Uint8Array;
}): JsonRpcRequest<RFQParams> {
  requireNonEmpty(params.buyer.agent_id, 'buyer.agent_id');
  requireNonEmpty(params.buyer.endpoint, 'buyer.endpoint');
  if (params.secretKey.length !== 64) {
    throw new OphirError(
      OphirErrorCode.INVALID_SIGNATURE,
      `Invalid secret key length: expected 64, got ${params.secretKey.length}`,
    );
  }
  const unsigned = {
    rfq_id: uuidv4(),
    buyer: params.buyer,
    service: params.service,
    budget: params.budget,
    sla_requirements: params.sla,
    negotiation_style: 'rfq' as const,
    max_rounds: params.maxRounds ?? DEFAULT_CONFIG.max_negotiation_rounds,
    expires_at: expiresAt(params.ttlMs ?? DEFAULT_CONFIG.rfq_timeout_ms),
    accepted_payments: params.acceptedPayments,
  };
  const signature = signMessage(unsigned, params.secretKey);
  const rfqParams: RFQParams = { ...unsigned, signature };
  return rpcEnvelope(METHODS.RFQ, rfqParams);
}

/**
 * Build a signed Quote response message. Signs the quote with the seller's Ed25519 key.
 *
 * @throws {OphirError} if rfqId or seller identity fields are missing.
 *
 * @example
 * ```typescript
 * const quote = buildQuote({
 *   rfqId: 'a1b2c3d4-...',
 *   seller: { agent_id: 'did:key:z6Mk...', endpoint: 'https://seller.example.com' },
 *   pricing: { price_per_unit: '0.005', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
 *   secretKey: keypair.secretKey,
 * });
 * ```
 */
export function buildQuote(params: {
  rfqId: string;
  seller: AgentIdentity;
  pricing: PricingOffer;
  sla?: SLARequirement;
  execution?: ExecutionInfo;
  escrow?: EscrowRequirement;
  ttlMs?: number;
  secretKey: Uint8Array;
}): JsonRpcRequest<QuoteParams> {
  requireNonEmpty(params.rfqId, 'rfqId');
  requireNonEmpty(params.seller.agent_id, 'seller.agent_id');
  requireNonEmpty(params.seller.endpoint, 'seller.endpoint');
  if (params.secretKey.length !== 64) {
    throw new OphirError(
      OphirErrorCode.INVALID_SIGNATURE,
      `Invalid secret key length: expected 64, got ${params.secretKey.length}`,
    );
  }
  const unsigned = {
    quote_id: uuidv4(),
    rfq_id: params.rfqId,
    seller: params.seller,
    pricing: params.pricing,
    sla_offered: params.sla,
    execution: params.execution,
    escrow_requirement: params.escrow,
    expires_at: expiresAt(params.ttlMs ?? DEFAULT_CONFIG.quote_timeout_ms),
  };
  const signature = signMessage(unsigned, params.secretKey);
  const quoteParams: QuoteParams = { ...unsigned, signature };
  return rpcEnvelope(METHODS.QUOTE, quoteParams);
}

/**
 * Build a signed counter-offer message. Signs with the sender's Ed25519 key.
 *
 * @throws {OphirError} if rfqId, inResponseTo, or from.agent_id are missing.
 *
 * @example
 * ```typescript
 * const counter = buildCounter({
 *   rfqId: 'a1b2c3d4-...',
 *   inResponseTo: 'e5f6g7h8-...',
 *   round: 1,
 *   from: { agent_id: 'did:key:z6Mk...', role: 'buyer' },
 *   modifications: { price_per_unit: '0.008' },
 *   secretKey: keypair.secretKey,
 * });
 * ```
 */
export function buildCounter(params: {
  rfqId: string;
  inResponseTo: string;
  round: number;
  from: { agent_id: string; role: 'buyer' | 'seller' };
  modifications: Record<string, unknown>;
  justification?: string;
  ttlMs?: number;
  secretKey: Uint8Array;
}): JsonRpcRequest<CounterParams> {
  requireNonEmpty(params.rfqId, 'rfqId');
  requireNonEmpty(params.inResponseTo, 'inResponseTo');
  requireNonEmpty(params.from.agent_id, 'from.agent_id');
  if (params.secretKey.length !== 64) {
    throw new OphirError(
      OphirErrorCode.INVALID_SIGNATURE,
      `Invalid secret key length: expected 64, got ${params.secretKey.length}`,
    );
  }
  const unsigned = {
    counter_id: uuidv4(),
    rfq_id: params.rfqId,
    in_response_to: params.inResponseTo,
    round: params.round,
    from: params.from,
    modifications: params.modifications,
    justification: params.justification,
    expires_at: expiresAt(params.ttlMs ?? DEFAULT_CONFIG.counter_timeout_ms),
  };
  const signature = signMessage(unsigned, params.secretKey);
  const counterParams: CounterParams = { ...unsigned, signature };
  return rpcEnvelope(METHODS.COUNTER, counterParams);
}

/**
 * Build an Accept message with agreement hash and buyer signature.
 *
 * Validates that finalTerms contains the required fields: price_per_unit, currency, and unit.
 *
 * @throws {OphirError} if rfqId, acceptingMessageId, or required finalTerms fields are missing.
 *
 * @example
 * ```typescript
 * const accept = buildAccept({
 *   rfqId: 'a1b2c3d4-...',
 *   acceptingMessageId: 'e5f6g7h8-...',
 *   finalTerms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
 *   buyerSecretKey: keypair.secretKey,
 * });
 * ```
 */
export function buildAccept(params: {
  rfqId: string;
  acceptingMessageId: string;
  finalTerms: FinalTerms;
  buyerSecretKey: Uint8Array;
  sellerSignature?: string;
}): JsonRpcRequest<AcceptParams> {
  requireNonEmpty(params.rfqId, 'rfqId');
  requireNonEmpty(params.acceptingMessageId, 'acceptingMessageId');
  if (!params.finalTerms || typeof params.finalTerms !== 'object') {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'finalTerms must be a non-null object',
    );
  }
  if (!params.finalTerms.price_per_unit || !params.finalTerms.currency || !params.finalTerms.unit) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'finalTerms must contain price_per_unit, currency, and unit',
    );
  }
  if (params.buyerSecretKey.length !== 64) {
    throw new OphirError(
      OphirErrorCode.INVALID_SIGNATURE,
      `Invalid buyer secret key length: expected 64, got ${params.buyerSecretKey.length}`,
    );
  }
  const hash = agreementHash(params.finalTerms);
  const unsigned = {
    agreement_id: uuidv4(),
    rfq_id: params.rfqId,
    accepting_message_id: params.acceptingMessageId,
    final_terms: params.finalTerms,
    agreement_hash: hash,
  };
  const buyerSig = signMessage(unsigned, params.buyerSecretKey);
  const acceptParams: AcceptParams = {
    ...unsigned,
    buyer_signature: buyerSig,
    ...(params.sellerSignature ? { seller_signature: params.sellerSignature } : {}),
  };
  return rpcEnvelope(METHODS.ACCEPT, acceptParams);
}

/**
 * Build a signed Reject message to decline a negotiation. Signs with the rejecting
 * agent's Ed25519 key so that receivers can verify the rejection is authorized.
 *
 * @throws {OphirError} if rfqId, rejectingMessageId, reason, or agentId are empty.
 * @throws {OphirError} if secretKey is not 64 bytes.
 *
 * @example
 * ```typescript
 * const reject = buildReject({
 *   rfqId: 'a1b2c3d4-...',
 *   rejectingMessageId: 'e5f6g7h8-...',
 *   reason: 'Price too high',
 *   agentId: 'did:key:z6Mk...',
 *   secretKey: keypair.secretKey,
 * });
 * ```
 */
export function buildReject(params: {
  rfqId: string;
  rejectingMessageId: string;
  reason: string;
  agentId: string;
  secretKey: Uint8Array;
}): JsonRpcRequest<RejectParams> {
  requireNonEmpty(params.rfqId, 'rfqId');
  requireNonEmpty(params.rejectingMessageId, 'rejectingMessageId');
  requireNonEmpty(params.reason, 'reason');
  requireNonEmpty(params.agentId, 'agentId');
  if (params.secretKey.length !== 64) {
    throw new OphirError(
      OphirErrorCode.INVALID_SIGNATURE,
      `Invalid secret key length: expected 64, got ${params.secretKey.length}`,
    );
  }
  const unsigned = {
    rfq_id: params.rfqId,
    rejecting_message_id: params.rejectingMessageId,
    reason: params.reason,
    from: { agent_id: params.agentId },
  };
  const signature = signMessage(unsigned, params.secretKey);
  const rejectParams: RejectParams = { ...unsigned, signature };
  return rpcEnvelope(METHODS.REJECT, rejectParams);
}

/**
 * Build a signed Dispute message with violation evidence.
 *
 * @throws {OphirError} if agreementId, filedBy.agent_id, requestedRemedy, or escrowAction are empty.
 *
 * @example
 * ```typescript
 * const dispute = buildDispute({
 *   agreementId: 'a1b2c3d4-...',
 *   filedBy: { agent_id: 'did:key:z6Mk...', role: 'buyer' },
 *   violation: {
 *     sla_metric: 'uptime_pct',
 *     agreed_value: 99.9,
 *     observed_value: 95.0,
 *     measurement_window: '24h',
 *     evidence_hash: 'abc123',
 *   },
 *   requestedRemedy: 'Full refund',
 *   escrowAction: 'release_to_buyer',
 *   secretKey: keypair.secretKey,
 * });
 * ```
 */
export function buildDispute(params: {
  agreementId: string;
  filedBy: { agent_id: string; role: 'buyer' | 'seller' };
  violation: ViolationEvidence;
  requestedRemedy: string;
  escrowAction: string;
  lockstepReport?: {
    verification_id: string;
    result: 'PASS' | 'FAIL';
    deviations: string[];
  };
  secretKey: Uint8Array;
}): JsonRpcRequest<DisputeParams> {
  requireNonEmpty(params.agreementId, 'agreementId');
  requireNonEmpty(params.filedBy.agent_id, 'filedBy.agent_id');
  requireNonEmpty(params.requestedRemedy, 'requestedRemedy');
  requireNonEmpty(params.escrowAction, 'escrowAction');
  if (params.secretKey.length !== 64) {
    throw new OphirError(
      OphirErrorCode.INVALID_SIGNATURE,
      `Invalid secret key length: expected 64, got ${params.secretKey.length}`,
    );
  }
  const unsigned = {
    dispute_id: uuidv4(),
    agreement_id: params.agreementId,
    filed_by: params.filedBy,
    violation: params.violation,
    requested_remedy: params.requestedRemedy,
    escrow_action: params.escrowAction,
    lockstep_report: params.lockstepReport,
  };
  const signature = signMessage(unsigned, params.secretKey);
  const disputeParams: DisputeParams = { ...unsigned, signature };
  return rpcEnvelope(METHODS.DISPUTE, disputeParams);
}
