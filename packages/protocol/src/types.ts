/**
 * @module types
 *
 * Core TypeScript interfaces for the Ophir Agent Negotiation Protocol.
 * Every interface has JSDoc comments describing its purpose and usage context.
 */

// ============================================================
// Agent & Service Building Blocks
// ============================================================

/** Agent identity using W3C did:key format for Ed25519 public keys. */
export interface AgentIdentity {
  /** DID identifier in did:key:z... format */
  agent_id: string;
  /** HTTP(S) endpoint for receiving JSON-RPC messages */
  endpoint: string;
  /** Reputation score from 0 to 1 based on completed jobs */
  reputation_score?: number;
  /** Number of successfully completed jobs */
  completed_jobs?: number;
}

/** Specification of the service being requested. */
export interface ServiceRequirement {
  /** Service category (e.g. 'inference', 'translation', 'data_processing') */
  category: string;
  /** Human-readable description of the service need */
  description?: string;
  /** Domain-specific requirements (e.g. { model: 'llama', gpu: 'a100' }) */
  requirements?: Record<string, unknown>;
}

/** Budget constraints set by the buyer for a negotiation. */
export interface BudgetConstraint {
  /** Maximum acceptable price per unit as a decimal string */
  max_price_per_unit: string;
  /** Payment currency (e.g. 'USDC') */
  currency: string;
  /** Pricing unit (e.g. 'request', 'token', 'MB') */
  unit: string;
  /** Total budget cap as a decimal string */
  total_budget?: string;
}

/** Accepted payment method for a negotiation. */
export interface PaymentMethod {
  /** Blockchain network (e.g. 'solana') */
  network: string;
  /** Token symbol (e.g. 'USDC') */
  token: string;
}

/** Volume discount tier offering a lower price at higher quantities. */
export interface VolumeDiscount {
  /** Minimum units to qualify for this discount tier */
  min_units: number;
  /** Discounted price per unit as a decimal string */
  price_per_unit: string;
}

/** Pricing offer from a seller in response to an RFQ. */
export interface PricingOffer {
  /** Price per unit as a decimal string */
  price_per_unit: string;
  /** Payment currency (e.g. 'USDC') */
  currency: string;
  /** Pricing unit (e.g. 'request', 'token', 'MB') */
  unit: string;
  /** Pricing model used for this offer */
  pricing_model: 'fixed' | 'dynamic' | 'auction';
  /** Minimum volume commitment as a decimal string */
  minimum_commitment?: string;
  /** Volume discount tiers */
  volume_discounts?: VolumeDiscount[];
}

// ============================================================
// SLA Metrics & Requirements
// ============================================================

/** Standard SLA metric names supported by the protocol. */
export type SLAMetricName =
  | 'uptime_pct'
  | 'p50_latency_ms'
  | 'p99_latency_ms'
  | 'accuracy_pct'
  | 'throughput_rpm'
  | 'error_rate_pct'
  | 'time_to_first_byte_ms'
  | 'custom';

/** Definition of a single SLA metric with target value and comparison operator. */
export interface SLAMetric {
  /** Metric name from the standard set, or 'custom' with custom_name */
  name: SLAMetricName;
  /** Target value for the metric */
  target: number;
  /** How the observed value is compared to the target */
  comparison: 'gte' | 'lte' | 'eq' | 'between';
  /** Method used to measure the metric */
  measurement_method?: 'rolling_average' | 'percentile' | 'absolute' | 'sampled';
  /** Time window for measurement (e.g. '1h', '24h', '7d') */
  measurement_window?: string;
  /** Penalty structure for each violation of this metric */
  penalty_per_violation?: {
    /** Penalty amount as a decimal string */
    amount: string;
    /** Penalty currency */
    currency: string;
    /** Maximum penalties within a measurement window */
    max_penalties_per_window?: number;
  };
  /** Custom metric name (required when name is 'custom') */
  custom_name?: string;
}

/** SLA requirement with metrics and dispute resolution configuration. */
export interface SLARequirement {
  /** Array of SLA metrics to enforce */
  metrics: SLAMetric[];
  /** Dispute resolution configuration */
  dispute_resolution?: {
    /** Method for resolving disputes */
    method: 'automatic_escrow' | 'lockstep_verification' | 'timeout_release' | 'manual_arbitration';
    /** Timeout for dispute resolution in hours */
    timeout_hours?: number;
    /** DID of the arbitrator agent (for manual_arbitration) */
    arbitrator?: string;
  };
}

/** Execution details provided by the seller. */
export interface ExecutionInfo {
  /** Estimated start time as ISO 8601 string */
  estimated_start?: string;
  /** Estimated duration (e.g. '2h', '30m') */
  estimated_duration?: string;
  /** Available capacity description */
  capacity?: string;
}

/** Escrow requirement for securing payments on Solana. */
export interface EscrowRequirement {
  /** Escrow type — currently only Solana PDA is supported */
  type: 'solana_pda';
  /** Required deposit amount as a decimal string */
  deposit_amount: string;
  /** Condition that must be met to release escrowed funds */
  release_condition: string;
}

/** Lockstep behavioral verification specification. */
export interface LockstepSpec {
  /** Whether Lockstep verification is enabled */
  enabled: boolean;
  /** Endpoint for Lockstep verification service */
  verification_endpoint?: string;
  /** Hash of the behavioral specification */
  spec_hash?: string;
}

// ============================================================
// RPC Message Parameters
// ============================================================

/**
 * Parameters for a Request for Quote (negotiate/rfq). Signed by the buyer to prove authenticity.
 *
 * @example
 * ```typescript
 * const rfq: RFQParams = {
 *   rfq_id: '550e8400-e29b-41d4-a716-446655440000',
 *   buyer: {
 *     agent_id: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
 *     endpoint: 'https://buyer.example.com/ophir',
 *   },
 *   service: { category: 'inference', description: 'LLM inference' },
 *   budget: { max_price_per_unit: '0.10', currency: 'USDC', unit: 'request' },
 *   negotiation_style: 'rfq',
 *   max_rounds: 3,
 *   expires_at: '2026-03-06T00:00:00.000Z',
 *   signature: 'base64EncodedEd25519Signature==',
 * };
 * ```
 */
export interface RFQParams {
  /** Unique identifier for this RFQ */
  rfq_id: string;
  /** Buyer's identity and endpoint */
  buyer: AgentIdentity;
  /** Service being requested */
  service: ServiceRequirement;
  /** Budget constraints */
  budget: BudgetConstraint;
  /** Required SLA metrics */
  sla_requirements?: SLARequirement;
  /** Negotiation style */
  negotiation_style: 'rfq' | 'auction' | 'fixed-price';
  /** Maximum number of counter-offer rounds */
  max_rounds?: number;
  /** Expiration timestamp as ISO 8601 string */
  expires_at: string;
  /** Accepted payment methods */
  accepted_payments?: PaymentMethod[];
  /** Ed25519 signature of the canonicalized RFQ params (base64). Proves the buyer authorized this RFQ. */
  signature: string;
}

/**
 * Parameters for a Quote response (negotiate/quote).
 *
 * @example
 * ```typescript
 * const quote: QuoteParams = {
 *   quote_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
 *   rfq_id: '550e8400-e29b-41d4-a716-446655440000',
 *   seller: {
 *     agent_id: 'did:key:z6MkpTHR8VNs5zE7t3FQ7aL3aX5FHzA3knDAw8B5Z6JdNMQF',
 *     endpoint: 'https://seller.example.com/ophir',
 *   },
 *   pricing: {
 *     price_per_unit: '0.05',
 *     currency: 'USDC',
 *     unit: 'request',
 *     pricing_model: 'fixed',
 *   },
 *   expires_at: '2026-03-06T00:00:00.000Z',
 *   signature: 'base64EncodedEd25519Signature==',
 * };
 * ```
 */
export interface QuoteParams {
  /** Unique identifier for this quote */
  quote_id: string;
  /** RFQ this quote responds to */
  rfq_id: string;
  /** Seller's identity and endpoint */
  seller: AgentIdentity;
  /** Pricing offer */
  pricing: PricingOffer;
  /** SLA the seller commits to */
  sla_offered?: SLARequirement;
  /** Execution timeline details */
  execution?: ExecutionInfo;
  /** Escrow requirement for payment security */
  escrow_requirement?: EscrowRequirement;
  /** Expiration timestamp as ISO 8601 string */
  expires_at: string;
  /** Ed25519 signature of the canonicalized quote (base64) */
  signature: string;
}

/** Parameters for a counter-offer (negotiate/counter). */
export interface CounterParams {
  /** Unique identifier for this counter-offer */
  counter_id: string;
  /** RFQ this counter relates to */
  rfq_id: string;
  /** Message ID this counter responds to */
  in_response_to: string;
  /** Current negotiation round number */
  round: number;
  /** Identity and role of the counter-offer sender */
  from: {
    agent_id: string;
    role: 'buyer' | 'seller';
  };
  /** Proposed modifications to terms */
  modifications: Record<string, unknown>;
  /** Reason for the counter-offer */
  justification?: string;
  /** Expiration timestamp as ISO 8601 string */
  expires_at: string;
  /** Ed25519 signature of the canonicalized counter (base64) */
  signature: string;
}

/** Final agreed terms that both parties commit to. */
export interface FinalTerms {
  /** Agreed price per unit as a decimal string */
  price_per_unit: string;
  /** Payment currency */
  currency: string;
  /** Pricing unit */
  unit: string;
  /** Agreed SLA requirements */
  sla?: SLARequirement;
  /** Escrow configuration for payment security */
  escrow?: {
    /** Blockchain network for escrow */
    network: string;
    /** Deposit amount as a decimal string */
    deposit_amount: string;
    /** Condition for releasing escrowed funds */
    release_condition: string;
  };
}

/** Parameters for accepting an agreement (negotiate/accept). */
export interface AcceptParams {
  /** Unique agreement identifier */
  agreement_id: string;
  /** RFQ this agreement finalizes */
  rfq_id: string;
  /** Message ID being accepted */
  accepting_message_id: string;
  /** Final agreed terms */
  final_terms: FinalTerms;
  /** SHA-256 hash of the canonicalized final terms */
  agreement_hash: string;
  /** Buyer's Ed25519 signature (base64) */
  buyer_signature: string;
  /** Seller's Ed25519 counter-signature (base64). Optional on the initial accept; the seller counter-signs and returns it in the response. */
  seller_signature?: string;
  /** Lockstep verification specification */
  lockstep_spec?: LockstepSpec;
}

/** Parameters for rejecting a negotiation (negotiate/reject). Signed by the rejecting agent to prove authorization. */
export interface RejectParams {
  /** RFQ being rejected */
  rfq_id: string;
  /** Message ID being rejected */
  rejecting_message_id: string;
  /** Human-readable reason for rejection */
  reason: string;
  /** Identity of the rejecting agent */
  from: {
    /** DID identifier of the rejecting agent in did:key:z... format */
    agent_id: string;
  };
  /** Ed25519 signature of the canonicalized reject params (base64). Proves the agent authorized this rejection. */
  signature: string;
}

// ============================================================
// Dispute Types
// ============================================================

/** Evidence of an SLA violation for dispute filing. */
export interface ViolationEvidence {
  /** Which SLA metric was violated */
  sla_metric: string;
  /** The agreed target value */
  agreed_value: number;
  /** The observed value that violated the SLA */
  observed_value: number;
  /** Time window during which the violation occurred */
  measurement_window: string;
  /** SHA-256 hash of the evidence data */
  evidence_hash: string;
  /** URL where full evidence can be retrieved */
  evidence_url?: string;
}

/** Parameters for filing a dispute (negotiate/dispute). */
export interface DisputeParams {
  /** Unique dispute identifier */
  dispute_id: string;
  /** Agreement being disputed */
  agreement_id: string;
  /** Identity and role of the dispute filer */
  filed_by: {
    agent_id: string;
    role: 'buyer' | 'seller';
  };
  /** Evidence of the SLA violation */
  violation: ViolationEvidence;
  /** Requested remedy (e.g. 'escrow_release', 'penalty') */
  requested_remedy: string;
  /** Action to take on the escrow (e.g. 'freeze', 'release_to_buyer') */
  escrow_action: string;
  /** Lockstep verification report, if available */
  lockstep_report?: {
    /** Lockstep verification run ID */
    verification_id: string;
    /** Verification result */
    result: 'PASS' | 'FAIL';
    /** List of behavioral deviations detected */
    deviations: string[];
  };
  /** Ed25519 signature of the canonicalized dispute (base64) */
  signature: string;
}

// ============================================================
// Negotiation State Machine
// ============================================================

/**
 * Negotiation state machine states.
 *
 * Valid transitions from each state:
 * - **IDLE** → `RFQ_SENT` (buyer sends an RFQ)
 * - **RFQ_SENT** → `QUOTES_RECEIVED` (seller responds with a quote) | `REJECTED` (buyer or seller rejects)
 * - **QUOTES_RECEIVED** → `COUNTERING` (either party counter-offers) | `ACCEPTED` (buyer accepts a quote) | `REJECTED` (buyer rejects all quotes)
 * - **COUNTERING** → `COUNTERING` (another counter round) | `ACCEPTED` (terms agreed) | `REJECTED` (party walks away)
 * - **ACCEPTED** → `MARGIN_ASSESSED` (clearinghouse margin assessment) | `REJECTED` (counter-sign refused)
 * - **MARGIN_ASSESSED** → `ESCROWED` (escrow funded on Solana) | `REJECTED` (rejected after assessment)
 * - **ESCROWED** → `ACTIVE` (service delivery begins)
 * - **ACTIVE** → `COMPLETED` (service delivered successfully) | `DISPUTED` (SLA violation filed)
 * - **COMPLETED** → terminal state
 * - **REJECTED** → terminal state
 * - **DISPUTED** → `RESOLVED` (dispute adjudicated)
 * - **RESOLVED** → terminal state
 */
export type NegotiationState =
  | 'IDLE'
  | 'RFQ_SENT'
  | 'QUOTES_RECEIVED'
  | 'COUNTERING'
  | 'ACCEPTED'
  | 'MARGIN_ASSESSED'
  | 'ESCROWED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'REJECTED'
  | 'DISPUTED'
  | 'RESOLVED';

// ============================================================
// JSON-RPC 2.0 Envelope Types
// ============================================================

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest<T> {
  /** JSON-RPC protocol version — always "2.0" */
  jsonrpc: '2.0';
  /** The Ophir method name (e.g. "negotiate/rfq") */
  method: string;
  /** Unique request identifier for correlating responses */
  id: string;
  /** Method-specific parameters */
  params: T;
}

/** JSON-RPC 2.0 response envelope. */
export interface JsonRpcResponse<T> {
  /** JSON-RPC protocol version — always "2.0" */
  jsonrpc: '2.0';
  /** Request ID this response corresponds to */
  id: string;
  /** Successful result payload (mutually exclusive with error) */
  result?: T;
  /** Error payload (mutually exclusive with result) */
  error?: {
    /** JSON-RPC error code */
    code: number;
    /** Human-readable error message */
    message: string;
    /** Additional structured error data */
    data?: Record<string, unknown>;
  };
}
