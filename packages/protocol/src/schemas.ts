/**
 * Zod runtime validation schemas for all Ophir protocol message types.
 *
 * These schemas enforce structural correctness of JSON-RPC params at runtime,
 * complementing the TypeScript interfaces in types.ts with validation logic
 * (e.g. did:key prefix, UUID format, numeric strings, ISO 8601 dates).
 */
import { z } from 'zod';

// --- Reusable validators ---

/** UUID v4 format regex — enforces version 4 (third group starts with 4) and variant 1 (fourth group starts with 8-b). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates a string as a UUID v4. */
const uuidString = z.string().regex(UUID_RE, 'Must be a valid UUID v4').describe('UUID v4 identifier');

/** Validates a string that must be parseable as a finite number. */
const numericString = z.string().min(1).refine(
  (v) => { const n = Number(v); return Number.isFinite(n); },
  { message: 'Must be a numeric string' },
).describe('Numeric string (e.g. "0.005")');

/** Validates an ISO 8601 datetime that must be in the future. */
const futureDateTime = z.string().datetime().refine(
  (v) => new Date(v).getTime() > Date.now(),
  { message: 'Must be a future datetime' },
).describe('ISO 8601 datetime that must be in the future');

/** Validates a hex-encoded SHA-256 hash (exactly 64 hex characters, case-insensitive). */
const sha256HexString = z.string().regex(
  /^[0-9a-f]{64}$/i,
  'Must be a 64-character hex SHA-256 hash',
).describe('SHA-256 hash as 64 hex characters');

/** Validates a base64-encoded Ed25519 signature (decodes to exactly 64 bytes). */
const base64Signature = z.string().min(1).refine(
  (v) => {
    try {
      const decoded = Buffer.from(v, 'base64');
      return decoded.length === 64;
    } catch {
      return false;
    }
  },
  { message: 'Must be a base64-encoded 64-byte Ed25519 signature' },
).describe('Base64-encoded Ed25519 signature (64 bytes)');

/** Validates a did:key identifier with Ed25519 multicodec prefix (z6Mk). */
const didKeyString = z.string().startsWith('did:key:z6Mk', 'Must be a did:key with Ed25519 prefix (z6Mk)').describe('W3C DID identifier using did:key method with Ed25519 key');

// --- Shared schemas ---

const AgentIdentitySchema = z.object({
  agent_id: didKeyString.describe('DID identifier in did:key:z6Mk... format'),
  endpoint: z.string().url().describe('HTTP(S) endpoint for receiving JSON-RPC messages'),
  reputation_score: z.number().min(0).max(1).optional().describe('Reputation score from 0 to 1'),
  completed_jobs: z.number().int().min(0).optional().describe('Number of successfully completed jobs'),
}).describe('Agent identity with DID and endpoint');

const ServiceRequirementSchema = z.object({
  category: z.string().min(1).describe('Service category (e.g. inference, translation)'),
  description: z.string().optional().describe('Human-readable description of the service need'),
  requirements: z.record(z.unknown()).optional().describe('Domain-specific requirements'),
}).describe('Specification of the service being requested');

const BudgetConstraintSchema = z.object({
  max_price_per_unit: numericString.describe('Maximum acceptable price per unit as a decimal string'),
  currency: z.string().min(1).describe('Payment currency (e.g. USDC)'),
  unit: z.string().min(1).describe('Pricing unit (e.g. request, token, MB)'),
  total_budget: numericString.optional().describe('Total budget cap as a decimal string'),
}).describe('Budget constraints set by the buyer');

const PaymentMethodSchema = z.object({
  network: z.string().min(1).describe('Blockchain network (e.g. solana)'),
  token: z.string().min(1).describe('Token symbol (e.g. USDC)'),
}).describe('Accepted payment method');

const VolumeDiscountSchema = z.object({
  min_units: z.number().int().positive().describe('Minimum units to qualify for this discount tier'),
  price_per_unit: numericString.describe('Discounted price per unit as a decimal string'),
}).describe('Volume discount tier');

const PricingOfferSchema = z.object({
  price_per_unit: numericString.describe('Price per unit as a decimal string'),
  currency: z.string().min(1).describe('Payment currency (e.g. USDC)'),
  unit: z.string().min(1).describe('Pricing unit (e.g. request, token, MB)'),
  pricing_model: z.enum(['fixed', 'dynamic', 'auction']).describe('Pricing model for this offer'),
  minimum_commitment: numericString.optional().describe('Minimum volume commitment as a decimal string'),
  volume_discounts: z.array(VolumeDiscountSchema).optional().describe('Volume discount tiers'),
}).describe('Pricing offer from a seller');

const SLAMetricNameSchema = z.enum([
  'uptime_pct',
  'p50_latency_ms',
  'p99_latency_ms',
  'accuracy_pct',
  'throughput_rpm',
  'error_rate_pct',
  'time_to_first_byte_ms',
  'custom',
]).describe('Standard SLA metric name');

const SLAMetricSchema = z.object({
  name: SLAMetricNameSchema.describe('Metric name from the standard set'),
  target: z.number().describe('Target value for the metric'),
  comparison: z.enum(['gte', 'lte', 'eq', 'between']).describe('Comparison operator for observed vs target'),
  measurement_method: z.enum(['rolling_average', 'percentile', 'absolute', 'sampled']).optional().describe('Method used to measure the metric'),
  measurement_window: z.string().regex(/^\d+[smhdw]$/, 'Must match pattern like "1h", "24h", "7d", "30m", "60s"').optional().describe('Time window for measurement (e.g. 1h, 24h, 7d)'),
  penalty_per_violation: z
    .object({
      amount: numericString.describe('Penalty amount as a decimal string'),
      currency: z.string().min(1).describe('Penalty currency'),
      max_penalties_per_window: z.number().int().positive().optional().describe('Maximum penalties within a measurement window'),
    })
    .optional()
    .describe('Penalty structure for each violation'),
  custom_name: z.string().optional().describe('Custom metric name (required when name is custom)'),
}).refine(
  (data) => data.name !== 'custom' || (data.custom_name !== undefined && data.custom_name.length > 0),
  { message: 'custom_name is required when name is "custom"', path: ['custom_name'] },
).describe('Single SLA metric definition');

const SLARequirementSchema = z.object({
  metrics: z.array(SLAMetricSchema).min(1).describe('Array of SLA metrics to enforce'),
  dispute_resolution: z
    .object({
      method: z.enum([
        'automatic_escrow',
        'lockstep_verification',
        'timeout_release',
        'manual_arbitration',
      ]).describe('Dispute resolution method'),
      timeout_hours: z.number().positive().optional().describe('Timeout for dispute resolution in hours'),
      arbitrator: z.string().optional().describe('DID of the arbitrator agent'),
    })
    .optional()
    .describe('Dispute resolution configuration'),
}).describe('SLA requirement with metrics and dispute resolution');

const ExecutionInfoSchema = z.object({
  estimated_start: z.string().optional().describe('Estimated start time as ISO 8601 string'),
  estimated_duration: z.string().optional().describe('Estimated duration (e.g. 2h, 30m)'),
  capacity: z.string().optional().describe('Available capacity description'),
}).describe('Execution details provided by the seller');

const EscrowRequirementSchema = z.object({
  type: z.literal('solana_pda').describe('Escrow type — currently only Solana PDA is supported'),
  deposit_amount: numericString.describe('Required deposit amount as a decimal string'),
  release_condition: z.string().min(1).describe('Condition that must be met to release escrowed funds'),
}).describe('Escrow requirement for securing payments on Solana');

const LockstepSpecSchema = z.object({
  enabled: z.boolean().describe('Whether Lockstep verification is enabled'),
  verification_endpoint: z.string().url().optional().describe('Endpoint for Lockstep verification service'),
  spec_hash: z.string().optional().describe('Hash of the behavioral specification'),
}).describe('Lockstep behavioral verification specification');

// --- Params schemas ---

/** Zod schema for validating incoming RFQ (Request for Quote) messages. */
export const RFQParamsSchema = z.object({
  rfq_id: uuidString.describe('Unique identifier for this RFQ'),
  buyer: AgentIdentitySchema.describe('Buyer agent identity and endpoint'),
  service: ServiceRequirementSchema.describe('Service being requested'),
  budget: BudgetConstraintSchema.describe('Budget constraints'),
  sla_requirements: SLARequirementSchema.optional().describe('Required SLA metrics'),
  negotiation_style: z.enum(['rfq', 'auction', 'fixed-price']).describe('Negotiation style'),
  max_rounds: z.number().int().positive().optional().describe('Maximum number of counter-offer rounds'),
  expires_at: futureDateTime.describe('Expiration timestamp as ISO 8601'),
  accepted_payments: z.array(PaymentMethodSchema).optional().describe('Accepted payment methods'),
  signature: base64Signature.describe('Ed25519 signature of the canonicalized RFQ params'),
}).strict().describe('Request for Quote parameters');

/** Zod schema for validating incoming quote response messages. */
export const QuoteParamsSchema = z.object({
  quote_id: uuidString.describe('Unique identifier for this quote'),
  rfq_id: uuidString.describe('RFQ this quote responds to'),
  seller: AgentIdentitySchema.describe('Seller agent identity and endpoint'),
  pricing: PricingOfferSchema.describe('Pricing offer'),
  sla_offered: SLARequirementSchema.optional().describe('SLA the seller commits to'),
  execution: ExecutionInfoSchema.optional().describe('Execution timeline details'),
  escrow_requirement: EscrowRequirementSchema.optional().describe('Escrow requirement for payment security'),
  expires_at: futureDateTime.describe('Expiration timestamp as ISO 8601'),
  signature: base64Signature.describe('Ed25519 signature of the canonicalized quote'),
}).strict().describe('Quote response parameters');

/** Zod schema for validating incoming counter-offer messages. */
export const CounterParamsSchema = z.object({
  counter_id: uuidString.describe('Unique identifier for this counter-offer'),
  rfq_id: uuidString.describe('RFQ this counter relates to'),
  in_response_to: uuidString.describe('Message ID this counter responds to'),
  round: z.number().int().positive().describe('Current negotiation round number'),
  from: z.object({
    agent_id: didKeyString.describe('DID identifier of the counter sender'),
    role: z.enum(['buyer', 'seller']).describe('Role of the counter sender'),
  }).describe('Identity and role of the counter-offer sender'),
  modifications: z.record(z.unknown()).describe('Proposed modifications to terms'),
  justification: z.string().optional().describe('Reason for the counter-offer'),
  expires_at: futureDateTime.describe('Expiration timestamp as ISO 8601'),
  signature: base64Signature.describe('Ed25519 signature of the canonicalized counter'),
}).strict().describe('Counter-offer parameters');

const FinalTermsSchema = z.object({
  price_per_unit: numericString.describe('Agreed price per unit as a decimal string'),
  currency: z.string().min(1).describe('Payment currency'),
  unit: z.string().min(1).describe('Pricing unit'),
  sla: SLARequirementSchema.optional().describe('Agreed SLA requirements'),
  escrow: z
    .object({
      network: z.string().min(1).describe('Blockchain network for escrow'),
      deposit_amount: numericString.describe('Deposit amount as a decimal string'),
      release_condition: z.string().min(1).describe('Condition for releasing escrowed funds'),
    })
    .optional()
    .describe('Escrow configuration for payment security'),
}).strict().describe('Final agreed terms');

/** Zod schema for validating incoming accept/agreement messages. */
export const AcceptParamsSchema = z.object({
  agreement_id: uuidString.describe('Unique agreement identifier'),
  rfq_id: uuidString.describe('RFQ this agreement finalizes'),
  accepting_message_id: uuidString.describe('Message ID being accepted'),
  final_terms: FinalTermsSchema.describe('Final agreed terms'),
  agreement_hash: sha256HexString.describe('SHA-256 hash of the canonicalized final terms'),
  buyer_signature: base64Signature.describe('Buyer Ed25519 signature'),
  seller_signature: base64Signature.optional().describe('Seller Ed25519 counter-signature'),
  lockstep_spec: LockstepSpecSchema.optional().describe('Lockstep verification specification'),
}).strict().describe('Accept/agreement parameters');

/** Zod schema for validating incoming rejection messages. */
export const RejectParamsSchema = z.object({
  rfq_id: uuidString.describe('RFQ being rejected'),
  rejecting_message_id: uuidString.describe('Message ID being rejected'),
  reason: z.string().min(1).describe('Human-readable reason for rejection'),
  from: z.object({
    agent_id: didKeyString.describe('DID identifier of the rejecting agent'),
  }).describe('Identity of the rejecting agent'),
  signature: base64Signature.describe('Ed25519 signature of the canonicalized reject params'),
}).strict().describe('Rejection parameters');

const ViolationEvidenceSchema = z.object({
  sla_metric: z.string().min(1).describe('Which SLA metric was violated'),
  agreed_value: z.number().describe('The agreed target value'),
  observed_value: z.number().describe('The observed value that violated the SLA'),
  measurement_window: z.string().min(1).describe('Time window during which the violation occurred'),
  evidence_hash: sha256HexString.describe('SHA-256 hash of the evidence data'),
  evidence_url: z.string().url().optional().describe('URL where full evidence can be retrieved'),
}).describe('Evidence of an SLA violation');

/** Zod schema for validating incoming SLA dispute messages. */
export const DisputeParamsSchema = z.object({
  dispute_id: uuidString.describe('Unique dispute identifier'),
  agreement_id: uuidString.describe('Agreement being disputed'),
  filed_by: z.object({
    agent_id: didKeyString.describe('DID identifier of the dispute filer'),
    role: z.enum(['buyer', 'seller']).describe('Role of the dispute filer'),
  }).describe('Identity and role of the dispute filer'),
  violation: ViolationEvidenceSchema.describe('Evidence of the SLA violation'),
  requested_remedy: z.string().min(1).describe('Requested remedy (e.g. escrow_release, penalty)'),
  escrow_action: z.string().min(1).describe('Action to take on the escrow (e.g. freeze, release_to_buyer)'),
  lockstep_report: z
    .object({
      verification_id: z.string().min(1).describe('Lockstep verification run ID'),
      result: z.enum(['PASS', 'FAIL']).describe('Verification result'),
      deviations: z.array(z.string()).describe('List of behavioral deviations detected'),
    })
    .optional()
    .describe('Lockstep verification report'),
  signature: base64Signature.describe('Ed25519 signature of the canonicalized dispute'),
}).strict().describe('Dispute parameters');

/** Zod schema for validating negotiation state machine states. */
export const NegotiationStateSchema = z.enum([
  'IDLE',
  'RFQ_SENT',
  'QUOTES_RECEIVED',
  'COUNTERING',
  'ACCEPTED',
  'ESCROWED',
  'ACTIVE',
  'COMPLETED',
  'REJECTED',
  'DISPUTED',
  'RESOLVED',
]).describe('Negotiation state machine state');

// --- JSON-RPC 2.0 envelope schemas ---

/** Map of method names to their parameter schemas. */
const METHOD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'negotiate/rfq': RFQParamsSchema,
  'negotiate/quote': QuoteParamsSchema,
  'negotiate/counter': CounterParamsSchema,
  'negotiate/accept': AcceptParamsSchema,
  'negotiate/reject': RejectParamsSchema,
  'negotiate/dispute': DisputeParamsSchema,
};

/** Zod schema for validating JSON-RPC 2.0 request envelopes. */
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0').describe('JSON-RPC protocol version'),
  method: z.string().min(1).describe('The Ophir method name'),
  id: z.string().min(1).describe('Unique request identifier'),
  params: z.record(z.unknown()).describe('Method-specific parameters'),
}).strict().describe('JSON-RPC 2.0 request envelope');

/** Zod schema for validating JSON-RPC 2.0 response envelopes. */
export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0').describe('JSON-RPC protocol version'),
  id: z.string().min(1).describe('Request ID this response corresponds to'),
  result: z.unknown().optional().describe('Successful result payload'),
  error: z.object({
    code: z.number().int().describe('JSON-RPC error code'),
    message: z.string().describe('Human-readable error message'),
    data: z.record(z.unknown()).optional().describe('Additional error data'),
  }).optional().describe('Error payload'),
}).strict().refine(
  (data) => (data.result !== undefined) !== (data.error !== undefined),
  { message: 'Response must have either result or error, but not both' },
).describe('JSON-RPC 2.0 response envelope');

/**
 * Validate a JSON-RPC 2.0 request envelope and its params against the
 * appropriate method schema. Returns the parsed request with validated params.
 *
 * @param data - The raw request data to validate.
 * @returns The validated request object.
 * @throws {z.ZodError} If validation fails.
 */
export function validateJsonRpcRequest(data: unknown): z.infer<typeof JsonRpcRequestSchema> {
  const envelope = JsonRpcRequestSchema.parse(data);
  const methodSchema = METHOD_SCHEMAS[envelope.method];
  if (methodSchema) {
    methodSchema.parse(envelope.params);
  }
  return envelope;
}

// Re-export shared schemas for composition
export {
  AgentIdentitySchema,
  ServiceRequirementSchema,
  BudgetConstraintSchema,
  PaymentMethodSchema,
  VolumeDiscountSchema,
  PricingOfferSchema,
  SLAMetricNameSchema,
  SLAMetricSchema,
  SLARequirementSchema,
  ExecutionInfoSchema,
  EscrowRequirementSchema,
  LockstepSpecSchema,
  FinalTermsSchema,
  ViolationEvidenceSchema,
  sha256HexString,
  base64Signature,
};
