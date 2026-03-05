import type { QuoteParams, FinalTerms } from '@ophir/protocol';

/** Configuration for connecting to the Solana escrow program. */
export interface EscrowConfig {
  /** Solana RPC endpoint URL (defaults to devnet). */
  rpcUrl?: string;
  /** Anchor program ID for the Ophir escrow program. */
  programId?: string;
}

/** A service offering advertised by a seller agent. */
export interface ServiceOffering {
  /** Service category (e.g. 'inference', 'translation', 'data_processing'). */
  category: string;
  /** Human-readable description of the service. */
  description: string;
  /** Base price per unit as a decimal string (e.g. '0.005'). */
  base_price: string;
  /** Payment currency (e.g. 'USDC'). */
  currency: string;
  /** Pricing unit (e.g. 'request', 'token', 'MB'). */
  unit: string;
  /** Maximum concurrent capacity, if limited. */
  capacity?: number;
}

/** Pricing strategy for automated quote generation by seller agents. */
export interface PricingStrategy {
  /** Strategy type: fixed base price, competitive (undercut), or dynamic. */
  type: 'fixed' | 'competitive' | 'dynamic';
  /** Margin adjustment factor (e.g. 0.1 for 10% margin). */
  margin?: number;
}

/** Custom comparator function for ranking quotes. Return negative if `a` is preferred. */
export type RankingFunction = (a: QuoteParams, b: QuoteParams) => number;

/** Registration info for a known seller agent. */
export interface SellerInfo {
  /** Seller's did:key identifier. */
  agentId: string;
  /** Seller's HTTP endpoint for receiving JSON-RPC messages. */
  endpoint: string;
  /** Services offered by this seller. */
  services: ServiceOffering[];
}

/** Finalized agreement between buyer and seller, signed by both parties. */
export interface Agreement {
  /** Unique agreement identifier. */
  agreement_id: string;
  /** RFQ that initiated this negotiation. */
  rfq_id: string;
  /** The quote or counter ID that was accepted. Stored so signatures can be independently verified. */
  accepting_message_id: string;
  /** Final agreed terms (price, currency, SLA, escrow). */
  final_terms: FinalTerms;
  /** SHA-256 hash of the canonicalized final terms. */
  agreement_hash: string;
  /** Buyer's Ed25519 signature over the unsigned accept payload (base64). */
  buyer_signature: string;
  /**
   * Seller's Ed25519 counter-signature over the same unsigned accept payload (base64).
   * Absent until the seller counter-signs the accept message.
   */
  seller_signature?: string;
  /** On-chain escrow details, if funded. */
  escrow?: {
    /** Solana escrow PDA address (base58). */
    address: string;
    /** Transaction signature from escrow creation. */
    txSignature: string;
  };
}

/** Result of a dispute resolution. */
export interface DisputeResult {
  /** Unique dispute identifier. */
  dispute_id: string;
  /** Current dispute outcome. */
  outcome: 'penalty_applied' | 'dismissed' | 'pending';
  /** Transaction signature if an on-chain action was taken. */
  txSignature?: string;
}

/** Result of a completed job execution. */
export interface JobResult {
  /** Agreement this job was executed under. */
  agreement_id: string;
  /** Job completion status. */
  status: 'completed' | 'failed';
  /** Observed SLA metrics from job execution. */
  metrics?: Record<string, number>;
}
