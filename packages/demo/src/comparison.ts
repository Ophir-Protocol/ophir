export interface ComparisonResult {
  without: {
    price_per_request: string;
    sla: string;
    recourse: string;
    cost_for_1000: number;
  };
  with: {
    price_per_request: string;
    sla: string;
    recourse: string;
    cost_for_1000: number;
  };
  savings: number;
  savings_pct: number;
}

export function computeComparison(
  posted_price: number,
  negotiated_price: number,
  sla_summary: string,
  volume: number = 1000,
): ComparisonResult {
  const without_cost = posted_price * volume;
  const with_cost = negotiated_price * volume;
  const savings = without_cost - with_cost;
  const savings_pct = Math.round((savings / without_cost) * 100);

  return {
    without: {
      price_per_request: `$${posted_price.toFixed(3)}`,
      sla: 'None',
      recourse: 'None',
      cost_for_1000: without_cost,
    },
    with: {
      price_per_request: `$${negotiated_price.toFixed(3)}`,
      sla: sla_summary,
      recourse: 'Escrow + automated dispute',
      cost_for_1000: with_cost,
    },
    savings,
    savings_pct,
  };
}

export function formatComparison(result: ComparisonResult): string {
  const lines = [
    'WITHOUT Ophir:',
    `  Price: ${result.without.price_per_request}/request (posted price, take it or leave it)`,
    `  SLA: ${result.without.sla}`,
    `  Recourse: ${result.without.recourse}`,
    `  Cost for 1000 requests: $${result.without.cost_for_1000.toFixed(2)}`,
    '',
    'WITH Ophir:',
    `  Price: ${result.with.price_per_request}/request (negotiated)`,
    `  SLA: ${result.with.sla}`,
    `  Recourse: ${result.with.recourse}`,
    `  Cost for 1000 requests: $${result.with.cost_for_1000.toFixed(2)}`,
    `  Savings: $${result.savings.toFixed(2)} (${result.savings_pct}%)`,
  ];
  return lines.join('\n');
}
