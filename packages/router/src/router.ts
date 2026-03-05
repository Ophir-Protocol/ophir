import { negotiate, agreementToX402Headers } from '@ophirai/sdk';
import type { NegotiateResult } from '@ophirai/sdk';
import type { QuoteParams, SLARequirement } from '@ophirai/protocol';
import { rankByStrategy } from './strategies.js';
import type { RoutingStrategy, StrategyContext } from './strategies.js';
import { SLAMonitor } from './monitor.js';

export interface RouterConfig {
  /** Default routing strategy (default: 'cheapest'). */
  strategy?: RoutingStrategy;
  /** Registry endpoints for seller discovery. */
  registries?: string[];
  /** Known seller endpoints (bypass registry). */
  sellers?: string[];
  /** Cache negotiated agreements for this many seconds (default: 300). */
  agreementCacheTtl?: number;
  /** Max budget per request (default: '1.00'). */
  maxBudget?: string;
  /** Currency (default: 'USDC'). */
  currency?: string;
  /** SLA requirements to include in negotiations. */
  sla?: SLARequirement;
  /** Maximum retries on provider failure before re-negotiating (default: 1). */
  maxRetries?: number;
}

export interface RouteResult {
  /** The selected provider's endpoint. */
  providerEndpoint: string;
  /** The agreement ID. */
  agreementId: string;
  /** The response from the provider. */
  response: unknown;
  /** Latency in ms. */
  latencyMs: number;
  /** Routing strategy used. */
  strategy: string;
  /** The quote that was selected. */
  selectedQuote?: QuoteParams;
}

interface CachedAgreement {
  result: NegotiateResult;
  expiresAt: number;
  sla?: SLARequirement;
}

export class OphirRouter {
  private config: Required<Pick<RouterConfig, 'strategy' | 'agreementCacheTtl' | 'maxBudget' | 'currency' | 'maxRetries'>> & RouterConfig;
  private monitor: SLAMonitor;
  private agreementCache = new Map<string, CachedAgreement>();
  private strategyContext: StrategyContext;

  constructor(config?: RouterConfig) {
    this.config = {
      strategy: 'cheapest',
      agreementCacheTtl: 300,
      maxBudget: '1.00',
      currency: 'USDC',
      maxRetries: 1,
      ...config,
    };
    this.monitor = new SLAMonitor();
    this.strategyContext = {
      latencyHistory: new Map(),
      slaHistory: new Map(),
      roundRobinIndex: 0,
    };
  }

  /**
   * Route a request: negotiate -> select provider -> forward -> monitor.
   * If a cached agreement exists for the model, reuse it.
   */
  async route(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  }): Promise<RouteResult> {
    const strategy = this.config.strategy;
    const cacheKey = this.buildCacheKey(params.model);

    // Evict expired cache entries lazily
    this.evictExpiredCache();

    // Sync SLA compliance data from monitor into strategy context
    this.syncSlaHistory();

    // 1. Check agreement cache
    let negotiateResult = this.getCachedAgreement(cacheKey);
    let cachedSla = negotiateResult ? this.agreementCache.get(cacheKey)?.sla : undefined;

    // 2. If no cached agreement, negotiate
    if (!negotiateResult) {
      negotiateResult = await negotiate({
        service: 'inference',
        model: params.model === 'auto' ? undefined : params.model,
        maxBudget: this.config.maxBudget,
        currency: this.config.currency,
        sellers: this.config.sellers,
        registries: this.config.registries,
        sla: this.config.sla,
        autoAccept: true,
      });

      if (negotiateResult.quotes.length === 0) {
        throw new Error('No providers available for the requested model');
      }

      // Determine the effective SLA from the accepted quote or config
      cachedSla = negotiateResult.acceptedQuote?.sla_offered
        ?? negotiateResult.agreement?.final_terms?.sla
        ?? this.config.sla;

      // Cache the result
      const ttl = this.config.agreementCacheTtl * 1000;
      this.agreementCache.set(cacheKey, {
        result: negotiateResult,
        expiresAt: Date.now() + ttl,
        sla: cachedSla,
      });
    }

    // 3. Filter out sellers with active violations, then rank
    const viableQuotes = this.filterViolatingProviders(negotiateResult.quotes);
    const quotesToRank = viableQuotes.length > 0 ? viableQuotes : negotiateResult.quotes;

    const ranked = rankByStrategy(quotesToRank, strategy, this.strategyContext);

    if (ranked.length === 0) {
      throw new Error('No quotes available after ranking');
    }

    // Advance round-robin counter
    if (strategy === 'round_robin') {
      this.strategyContext.roundRobinIndex++;
    }

    const bestQuote = ranked[0].quote;
    const providerEndpoint = bestQuote.seller.endpoint;
    const agreementId = negotiateResult.agreement?.agreement_id ?? bestQuote.quote_id;
    const agreementHash = negotiateResult.agreement?.agreement_hash ?? '';

    // Start monitoring if we have an agreement
    if (negotiateResult.agreement) {
      this.monitor.track(
        agreementId,
        bestQuote.seller.agent_id,
        agreementHash,
        cachedSla,
      );
    }

    // 4. Forward the request to the provider
    return this.forwardRequest(
      params,
      providerEndpoint,
      agreementId,
      bestQuote,
      negotiateResult,
      strategy,
    );
  }

  /** Get the SLA monitor for observability. */
  getMonitor(): SLAMonitor {
    return this.monitor;
  }

  /** Get the current strategy context (for testing/observability). */
  getStrategyContext(): Readonly<StrategyContext> {
    return this.strategyContext;
  }

  /** Invalidate the agreement cache for a specific model or all models. */
  invalidateCache(model?: string): void {
    if (model) {
      this.agreementCache.delete(this.buildCacheKey(model));
    } else {
      this.agreementCache.clear();
    }
  }

  private async forwardRequest(
    params: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      max_tokens?: number;
      stream?: boolean;
    },
    providerEndpoint: string,
    agreementId: string,
    quote: QuoteParams,
    negotiateResult: NegotiateResult,
    strategy: string,
  ): Promise<RouteResult> {
    const startTime = Date.now();

    // Build headers — include x402 payment headers if we have an agreement
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (negotiateResult.agreement) {
      try {
        const x402 = agreementToX402Headers(negotiateResult.agreement);
        Object.assign(headers, x402);
      } catch {
        // x402 headers are optional; continue without them
      }
    }

    try {
      const res = await fetch(`${providerEndpoint}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          temperature: params.temperature,
          max_tokens: params.max_tokens,
          stream: params.stream,
        }),
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const errorBody = await res.text();
        this.monitor.recordFailure(agreementId, `HTTP ${res.status}: ${errorBody}`);
        this.strategyContext.latencyHistory.set(quote.seller.agent_id, latencyMs);
        throw new Error(`Provider returned ${res.status}: ${errorBody}`);
      }

      const response = await res.json();
      const totalLatencyMs = Date.now() - startTime;

      // 5. Record metrics in the SLA monitor
      this.monitor.recordSuccess(agreementId, totalLatencyMs);
      this.strategyContext.latencyHistory.set(quote.seller.agent_id, totalLatencyMs);

      return {
        providerEndpoint,
        agreementId,
        response,
        latencyMs: totalLatencyMs,
        strategy,
        selectedQuote: quote,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      // Only record if not already recorded (i.e., network-level failures)
      if (!(error instanceof Error && error.message.startsWith('Provider returned'))) {
        this.monitor.recordFailure(agreementId, String(error));
        this.strategyContext.latencyHistory.set(quote.seller.agent_id, latencyMs);
      }

      throw error;
    }
  }

  private getCachedAgreement(cacheKey: string): NegotiateResult | null {
    const cached = this.agreementCache.get(cacheKey);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.agreementCache.delete(cacheKey);
      return null;
    }

    return cached.result;
  }

  /** Build a cache key from the model name. Normalizes 'auto' to a wildcard. */
  private buildCacheKey(model: string): string {
    return model === 'auto' ? '__auto__' : model;
  }

  /** Remove expired entries from the agreement cache. */
  private evictExpiredCache(): void {
    const now = Date.now();
    for (const [key, cached] of this.agreementCache) {
      if (now > cached.expiresAt) {
        this.agreementCache.delete(key);
      }
    }
  }

  /** Sync monitor compliance data into the strategy context's slaHistory. */
  private syncSlaHistory(): void {
    for (const agreeId of this.monitor.getAgreementIds()) {
      const stats = this.monitor.getStats(agreeId);
      if (!stats || stats.requestCount === 0) continue;

      const sellerId = this.monitor.getSellerForAgreement(agreeId);
      if (sellerId) {
        this.strategyContext.slaHistory.set(sellerId, stats.slaCompliance);
      }
    }
  }

  /** Filter out quotes from providers that have active SLA violations. */
  private filterViolatingProviders(quotes: QuoteParams[]): QuoteParams[] {
    const violatingSellers = new Set<string>();
    for (const v of this.monitor.getViolations()) {
      violatingSellers.add(v.sellerId);
    }

    if (violatingSellers.size === 0) return quotes;

    return quotes.filter((q) => !violatingSellers.has(q.seller.agent_id));
  }
}
