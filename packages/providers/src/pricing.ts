export interface PricingContext {
  /** Current utilization, 0-1. */
  currentLoad: number;
  /** Multiplier from recent RFQ volume. */
  demandMultiplier: number;
  /** UTC hour, 0-23. */
  timeOfDay: number;
}

/**
 * Calculate dynamic price based on base price and current conditions.
 * - High demand (>0.8 load) → up to 1.5x price
 * - Low demand (<0.2 load) → down to 0.8x price
 * - Off-peak hours (UTC 0-8) → 0.9x modifier
 */
export function dynamicPrice(basePrice: number, context?: PricingContext): number {
  if (!context) return basePrice;

  let multiplier = 1;

  // Load-based pricing: linear interpolation
  if (context.currentLoad > 0.8) {
    // 0.8 → 1.0x, 1.0 → 1.5x
    const t = (context.currentLoad - 0.8) / 0.2;
    multiplier *= 1 + t * 0.5;
  } else if (context.currentLoad < 0.2) {
    // 0.0 → 0.8x, 0.2 → 1.0x
    const t = context.currentLoad / 0.2;
    multiplier *= 0.8 + t * 0.2;
  }

  // Demand multiplier applied directly
  multiplier *= context.demandMultiplier;

  // Off-peak discount (UTC 0-8)
  if (context.timeOfDay >= 0 && context.timeOfDay < 8) {
    multiplier *= 0.9;
  }

  return basePrice * multiplier;
}
