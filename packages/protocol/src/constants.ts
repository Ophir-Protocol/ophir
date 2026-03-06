/**
 * Default protocol configuration values for Ophir negotiations.
 *
 * These values are used when explicit configuration is not provided.
 * Timeouts are in milliseconds; `escrow_pda_seeds` defines the base
 * seed for Solana PDA derivation (buyer pubkey and agreement hash
 * are appended at runtime).
 */
export const DEFAULT_CONFIG = {
  /** Solana RPC endpoint for devnet. */
  solana_rpc: 'https://api.devnet.solana.com',
  /** Maximum time to wait for quotes after sending an RFQ (5 minutes). */
  rfq_timeout_ms: 5 * 60 * 1000,
  /** Maximum time for a seller to respond with a quote (2 minutes). */
  quote_timeout_ms: 2 * 60 * 1000,
  /** Maximum time for a party to respond to a counter-offer (2 minutes). */
  counter_timeout_ms: 2 * 60 * 1000,
  /** Maximum number of counter-offer rounds before negotiation fails. */
  max_negotiation_rounds: 5,
  /** Default payment currency. */
  currency: 'USDC',
  /** Base PDA seed for escrow accounts (buyer_pubkey + agreement_hash appended). */
  escrow_pda_seeds: ['escrow'],
  /** Default blockchain network for payments. */
  payment_network: 'solana',
  /** Default payment token. */
  payment_token: 'USDC',
  /** Window in milliseconds for tracking seen message IDs to prevent replay attacks (10 minutes). */
  replay_protection_window_ms: 10 * 60 * 1000,
} as const;

/** Protocol version identifier. */
export const PROTOCOL_VERSION = '1.0' as const;

/** Ophir escrow program ID on Solana mainnet/devnet. */
export const ESCROW_PROGRAM_ID = 'Bcvw9tYGPu7M9hx7YRatv4GLz9Kv2BtZUckaoUgKfUFA' as const;

/** All supported SLA metric names. */
export const SUPPORTED_SLA_METRICS: readonly string[] = [
  'uptime_pct',
  'p50_latency_ms',
  'p99_latency_ms',
  'accuracy_pct',
  'throughput_rpm',
  'error_rate_pct',
  'time_to_first_byte_ms',
  'custom',
] as const;

/** All valid negotiation states in lifecycle order. */
export const NEGOTIATION_STATES: readonly string[] = [
  'IDLE',
  'RFQ_SENT',
  'QUOTES_RECEIVED',
  'COUNTERING',
  'ACCEPTED',
  'MARGIN_ASSESSED',
  'ESCROWED',
  'ACTIVE',
  'COMPLETED',
  'REJECTED',
  'DISPUTED',
  'RESOLVED',
] as const;
