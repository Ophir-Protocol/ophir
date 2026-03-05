import type { QuoteParams, SLARequirement } from '@ophirai/protocol';
import { generateKeyPair } from './identity.js';
import { BuyerAgent } from './buyer.js';
import { autoDiscover } from './registry.js';
import type { Agreement } from './types.js';

/** Options for the high-level {@link negotiate} function. */
export interface NegotiateOptions {
  /** Service category to negotiate for (e.g. 'inference', 'translation'). */
  service: string;
  /** Specific model or variant (e.g. 'gpt-4', 'llama-3-70b'). Optional. */
  model?: string;
  /** Maximum price per unit as decimal string (e.g. '0.01'). */
  maxBudget: string;
  /** Payment currency (default: 'USDC'). */
  currency?: string;
  /** Pricing unit (default: 'request'). */
  unit?: string;
  /** Minimum SLA requirements. If not provided, uses a sensible default. */
  sla?: SLARequirement;
  /** Known seller endpoints to contact directly (bypasses registry). */
  sellers?: string[];
  /** Registry endpoints for auto-discovery. */
  registries?: string[];
  /** Timeout in ms for the entire negotiation (default: 60_000). */
  timeout?: number;
  /** Ranking strategy: 'cheapest' | 'fastest' | 'best_sla' (default: 'cheapest'). */
  ranking?: 'cheapest' | 'fastest' | 'best_sla';
  /** If true, auto-accept the best quote. If false, return quotes for manual selection (default: true). */
  autoAccept?: boolean;
}

/** Result returned by the {@link negotiate} function. */
export interface NegotiateResult {
  /** The finalized agreement (if autoAccept was true and a quote was accepted). */
  agreement?: Agreement;
  /** All received quotes, ranked. */
  quotes: QuoteParams[];
  /** The accepted quote (first in ranked list if autoAccept). */
  acceptedQuote?: QuoteParams;
  /** Number of sellers contacted. */
  sellersContacted: number;
  /** Total negotiation time in ms. */
  durationMs: number;
}

const DEFAULT_SLA: SLARequirement = {
  metrics: [
    { name: 'uptime_pct', target: 99.0, comparison: 'gte' },
    { name: 'p99_latency_ms', target: 5000, comparison: 'lte' },
  ],
  dispute_resolution: { method: 'automatic_escrow' },
};

/**
 * High-level one-call negotiation that encapsulates the entire buyer flow:
 * discovery, RFQ broadcast, quote collection, ranking, and optional acceptance.
 *
 * Creates a temporary BuyerAgent, negotiates with discovered or specified sellers,
 * and returns the ranked quotes (and agreement if auto-accepted).
 *
 * @example
 * ```typescript
 * const result = await negotiate({
 *   service: 'inference',
 *   model: 'llama-3-70b',
 *   maxBudget: '0.01',
 *   sellers: ['http://seller1:3000', 'http://seller2:3000'],
 * });
 * if (result.agreement) {
 *   console.log('Agreement reached:', result.agreement.agreement_id);
 * }
 * ```
 */
export async function negotiate(options: NegotiateOptions): Promise<NegotiateResult> {
  const start = Date.now();
  const timeout = options.timeout ?? 60_000;
  const currency = options.currency ?? 'USDC';
  const unit = options.unit ?? 'request';
  const ranking = options.ranking ?? 'cheapest';
  const autoAccept = options.autoAccept ?? true;
  const sla = options.sla ?? DEFAULT_SLA;

  const keypair = generateKeyPair();
  const buyer = new BuyerAgent({
    keypair,
    endpoint: 'http://127.0.0.1:0',
  });

  try {
    await buyer.listen(0);

    // Discover sellers
    let sellerEndpoints: string[];
    if (options.sellers && options.sellers.length > 0) {
      sellerEndpoints = options.sellers;
    } else {
      const discovered = await autoDiscover(options.service, {
        registries: options.registries,
      });
      sellerEndpoints = discovered.map((a) => a.endpoint);
    }

    if (sellerEndpoints.length === 0) {
      return {
        quotes: [],
        sellersContacted: 0,
        durationMs: Date.now() - start,
      };
    }

    // Build requirements, including model if specified
    const requirements: Record<string, string> = {};
    if (options.model) {
      requirements.model = options.model;
    }

    const session = await buyer.requestQuotes({
      sellers: sellerEndpoints,
      service: {
        category: options.service,
        ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
      },
      budget: {
        max_price_per_unit: options.maxBudget,
        currency,
        unit,
      },
      sla,
      timeout,
    });

    // Wait for quotes, using remaining time as the timeout
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, timeout - elapsed);
    const quotes = await buyer.waitForQuotes(session, {
      minQuotes: 1,
      timeout: remaining,
    });

    const ranked = buyer.rankQuotes(quotes, ranking);

    const result: NegotiateResult = {
      quotes: ranked,
      sellersContacted: sellerEndpoints.length,
      durationMs: Date.now() - start,
    };

    if (autoAccept && ranked.length > 0) {
      const topQuote = ranked[0];
      try {
        const agreement = await buyer.acceptQuote(topQuote);
        result.agreement = agreement;
        result.acceptedQuote = topQuote;
      } catch {
        // Accept failed — return quotes without agreement
        result.acceptedQuote = topQuote;
      }
    }

    return result;
  } finally {
    await buyer.close();
  }
}
