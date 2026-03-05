import type { QuoteParams } from '@ophirai/protocol';

export type RoutingStrategy = 'cheapest' | 'fastest' | 'best_sla' | 'round_robin' | 'weighted';

export interface ProviderScore {
  quote: QuoteParams;
  score: number;
  reason: string;
}

export interface StrategyContext {
  /** Historical latency data per seller (agentId → avg latency ms). */
  latencyHistory: Map<string, number>;
  /** Historical SLA compliance per seller (agentId → compliance 0-1). */
  slaHistory: Map<string, number>;
  /** Round-robin counter. */
  roundRobinIndex: number;
  /** Weights for weighted strategy. */
  weights?: { price: number; latency: number; sla: number };
}

const DEFAULT_WEIGHTS = { price: 0.4, latency: 0.3, sla: 0.3 };

function price(quote: QuoteParams): number {
  return parseFloat(quote.pricing.price_per_unit);
}

function median(values: number[]): number {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function slaScore(quote: QuoteParams, slaHistory: Map<string, number>): number {
  const historical = slaHistory.get(quote.seller.agent_id);
  if (historical !== undefined) return historical;
  // Fall back to offered SLA metrics — average of uptime-like targets normalized to 0-1
  const metrics = quote.sla_offered?.metrics;
  if (metrics && metrics.length > 0) {
    const sum = metrics.reduce((acc, m) => {
      // Normalize percentage-based metrics to 0-1
      return acc + (m.target > 1 ? m.target / 100 : m.target);
    }, 0);
    return sum / metrics.length;
  }
  return 0.5; // unknown default
}

function rankCheapest(quotes: QuoteParams[]): ProviderScore[] {
  return [...quotes]
    .sort((a, b) => price(a) - price(b))
    .map((q, i) => ({
      quote: q,
      score: 1 / (1 + i),
      reason: `price ${q.pricing.price_per_unit} ${q.pricing.currency}/${q.pricing.unit}`,
    }));
}

function rankFastest(quotes: QuoteParams[], ctx: StrategyContext): ProviderScore[] {
  const knownLatencies = [...ctx.latencyHistory.values()];
  const med = median(knownLatencies);

  return [...quotes]
    .sort((a, b) => {
      const la = ctx.latencyHistory.get(a.seller.agent_id) ?? med;
      const lb = ctx.latencyHistory.get(b.seller.agent_id) ?? med;
      return la - lb;
    })
    .map((q, i) => {
      const lat = ctx.latencyHistory.get(q.seller.agent_id) ?? med;
      return {
        quote: q,
        score: 1 / (1 + i),
        reason: `latency ${lat === med && !ctx.latencyHistory.has(q.seller.agent_id) ? '~' : ''}${lat.toFixed(0)}ms`,
      };
    });
}

function rankBestSla(quotes: QuoteParams[], ctx: StrategyContext): ProviderScore[] {
  return [...quotes]
    .sort((a, b) => {
      const sa = slaScore(a, ctx.slaHistory);
      const sb = slaScore(b, ctx.slaHistory);
      return sb - sa; // descending
    })
    .map((q, i) => {
      const s = slaScore(q, ctx.slaHistory);
      return {
        quote: q,
        score: s,
        reason: `SLA compliance ${(s * 100).toFixed(1)}%`,
      };
    });
}

function rankRoundRobin(quotes: QuoteParams[], ctx: StrategyContext): ProviderScore[] {
  if (quotes.length === 0) return [];
  const idx = ctx.roundRobinIndex % quotes.length;
  const rotated = [...quotes.slice(idx), ...quotes.slice(0, idx)];
  return rotated.map((q, i) => ({
    quote: q,
    score: 1 / (1 + i),
    reason: i === 0 ? 'round-robin selected' : `round-robin position ${i + 1}`,
  }));
}

function rankWeighted(quotes: QuoteParams[], ctx: StrategyContext): ProviderScore[] {
  const w = ctx.weights ?? DEFAULT_WEIGHTS;
  const knownLatencies = [...ctx.latencyHistory.values()];
  const med = median(knownLatencies);

  const scored = quotes.map((q) => {
    const p = price(q);
    const lat = ctx.latencyHistory.get(q.seller.agent_id) ?? med;
    const sla = slaScore(q, ctx.slaHistory);

    const priceComponent = p > 0 ? 1 / p : 0;
    const latencyComponent = lat > 0 && isFinite(lat) ? 1 / lat : 0;
    const composite = w.price * priceComponent + w.latency * latencyComponent + w.sla * sla;

    return {
      quote: q,
      score: composite,
      reason: `weighted(p=${priceComponent.toFixed(3)}, l=${latencyComponent.toFixed(5)}, s=${sla.toFixed(2)}) = ${composite.toFixed(4)}`,
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Rank quotes according to the given strategy.
 * Returns sorted array (best first) with scores and reasons.
 */
export function rankByStrategy(
  quotes: QuoteParams[],
  strategy: RoutingStrategy,
  context: StrategyContext,
): ProviderScore[] {
  switch (strategy) {
    case 'cheapest':
      return rankCheapest(quotes);
    case 'fastest':
      return rankFastest(quotes, context);
    case 'best_sla':
      return rankBestSla(quotes, context);
    case 'round_robin':
      return rankRoundRobin(quotes, context);
    case 'weighted':
      return rankWeighted(quotes, context);
  }
}
