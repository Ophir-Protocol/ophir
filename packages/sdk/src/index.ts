/**
 * @module @ophir/sdk
 *
 * SDK for the Ophir Agent Negotiation Protocol.
 * Provides BuyerAgent, SellerAgent, Ed25519 signing, JSON-RPC transport,
 * Solana escrow management, and integration utilities.
 */

// ── Cryptographic signing ────────────────────────────────────────────
export {
  canonicalize,
  sign,
  verify,
  agreementHash,
  signMessage,
  verifyMessage,
} from './signing.js';

// ── Agent identity (did:key) ─────────────────────────────────────────
export {
  generateKeyPair,
  publicKeyToDid,
  didToPublicKey,
  generateAgentIdentity,
} from './identity.js';

// ── Core types ───────────────────────────────────────────────────────
/** Shared types for escrow configuration, service offerings, pricing, and agreements. */
export type {
  /** Configuration for Solana escrow operations (program ID, RPC endpoint). */
  EscrowConfig,
  /** A service a seller offers (category, description, base price, currency, unit). */
  ServiceOffering,
  /** Pricing strategy for quote generation (fixed, competitive, dynamic). */
  PricingStrategy,
  /** Custom comparator function for ranking quotes. */
  RankingFunction,
  /** Seller identity and service catalog, parsed from an Agent Card. */
  SellerInfo,
  /** Dual-signed agreement between buyer and seller with final terms and agreement hash. */
  Agreement,
  /** Result of filing an SLA dispute (dispute ID and outcome status). */
  DisputeResult,
  /** Result of a job execution (success flag, data, and optional error). */
  JobResult,
} from './types.js';

// ── JSON-RPC transport ──────────────────────────────────────────────
/** JSON-RPC 2.0 client for sending negotiation messages over HTTPS. */
export { JsonRpcClient } from './transport.js';
/** Configuration options for the JSON-RPC client (timeout, headers). */
export type { JsonRpcClientConfig } from './transport.js';

// ── Negotiation state machine ────────────────────────────────────────
/** Tracks the state of a single negotiation session, enforcing valid transitions. */
export { NegotiationSession } from './negotiation.js';

// ── JSON-RPC server ─────────────────────────────────────────────────
/** Express-based JSON-RPC 2.0 server that dispatches to registered method handlers. */
export { NegotiationServer } from './server.js';

// ── Message builders ────────────────────────────────────────────────
export {
  buildRFQ,
  buildQuote,
  buildCounter,
  buildAccept,
  buildReject,
  buildDispute,
} from './messages.js';

// ── SLA utilities ───────────────────────────────────────────────────
/** Pre-built SLA templates and comparison/conversion utilities. */
export {
  SLA_TEMPLATES,
  compareSLAs,
  meetsSLARequirements,
  slaToLockstepSpec,
} from './sla.js';
export type {
  /** Result of comparing two SLA specifications metric-by-metric. */
  SLAComparisonResult,
  /** Per-metric comparison detail (name, offered vs required, met flag). */
  SLAComparisonDetail,
  /** Result of checking if an SLA meets requirements (meets flag, gaps). */
  SLAMeetsResult,
  /** A gap between a required SLA target and an offered value. */
  SLAGap,
  /** A single behavioral check in a Lockstep verification spec. */
  LockstepBehavioralCheck,
  /** Full Lockstep verification spec converted from SLA terms. */
  LockstepVerificationSpec,
} from './sla.js';

// ── Seller agent ────────────────────────────────────────────────────
/** Sell-side agent that receives RFQs, generates quotes, and manages agreements. */
export { SellerAgent } from './seller.js';
/** Configuration for creating a SellerAgent (keypair, endpoint, services, pricing). */
export type { SellerAgentConfig } from './seller.js';

// ── Buyer agent ─────────────────────────────────────────────────────
/** Buy-side agent that sends RFQs, collects quotes, ranks, and accepts offers. */
export { BuyerAgent } from './buyer.js';
/** Configuration for creating a BuyerAgent (keypair, endpoint, escrow config). */
export type { BuyerAgentConfig } from './buyer.js';

// ── Solana escrow ───────────────────────────────────────────────────
/** Manages Solana PDA escrow operations (create, release, dispute, cancel). */
export { EscrowManager } from './escrow.js';
/** On-chain escrow status enum (Active, Released, Disputed, Cancelled). */
export type { EscrowStatus, EscrowAccountData } from './escrow.js';

// ── Agent discovery (A2A) ───────────────────────────────────────────
/** Discover agents via A2A Agent Cards at /.well-known/agent.json endpoints. */
export { discoverAgents, parseAgentCard } from './discovery.js';
/** A2A-compatible Agent Card describing an agent's identity and capabilities. */
export type { AgentCard, NegotiationCapability } from './discovery.js';

// ── Lockstep verification ───────────────────────────────────────────
/** Convert agreements to Lockstep specs and monitor SLA compliance. */
export { agreementToLockstepSpec, LockstepMonitor } from './lockstep.js';
export type {
  /** Lockstep behavioral verification specification derived from SLA terms. */
  LockstepSpec,
  /** A single behavioral requirement in a Lockstep verification spec. */
  LockstepBehavioralRequirement,
  /** Configuration for the LockstepMonitor (verification endpoint URL). */
  LockstepMonitorConfig,
  /** Result of an SLA compliance check (compliant flag and violation details). */
  ComplianceResult,
} from './lockstep.js';

// ── x402 payment headers ───────────────────────────────────────────
/** Convert agreements to x402 HTTP payment headers and parse responses. */
export { agreementToX402Headers, parseX402Response } from './x402.js';

// ── Re-export protocol types for convenience ────────────────────────
/** All protocol-level types re-exported from @ophir/protocol for convenience. */
export type {
  /** Agent identity with did:key identifier and HTTP endpoint. */
  AgentIdentity,
  /** Service category and requirements specified by the buyer. */
  ServiceRequirement,
  /** Budget constraints (max price, currency, unit, total budget). */
  BudgetConstraint,
  /** SLA requirements with metrics and dispute resolution terms. */
  SLARequirement,
  /** Single SLA metric (name, target, comparison operator). */
  SLAMetric,
  /** Accepted payment method (network and token). */
  PaymentMethod,
  /** Seller's pricing offer (price, currency, unit, model, volume discounts). */
  PricingOffer,
  /** Execution metadata for a running service. */
  ExecutionInfo,
  /** Escrow deposit requirements from a seller's quote. */
  EscrowRequirement,
  /** Agreed-upon final terms (price, currency, unit, SLA, escrow). */
  FinalTerms,
  /** Evidence of an SLA violation for dispute filing. */
  ViolationEvidence,
  /** Union type of all 11 negotiation states. */
  NegotiationState,
  /** Parameters for a negotiate/rfq message. */
  RFQParams,
  /** Parameters for a negotiate/quote message. */
  QuoteParams,
  /** Parameters for a negotiate/counter message. */
  CounterParams,
  /** Parameters for a negotiate/accept message (dual-signed). */
  AcceptParams,
  /** Parameters for a negotiate/reject message. */
  RejectParams,
  /** Parameters for a negotiate/dispute message. */
  DisputeParams,
  /** JSON-RPC 2.0 request envelope with typed params. */
  JsonRpcRequest,
  /** JSON-RPC 2.0 response envelope with typed result. */
  JsonRpcResponse,
} from '@ophir/protocol';
