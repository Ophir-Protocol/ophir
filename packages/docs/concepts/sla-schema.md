# SLA Schema

Ophir defines a structured SLA (Service Level Agreement) schema that both buyer and seller agents use to negotiate and enforce quality guarantees. SLAs are first-class objects in the protocol -- they travel with every quote, are signed by both parties, and are enforced through on-chain escrow penalties.

---

## Metric Types

The protocol supports 8 standard metric types that cover the most common quality dimensions for AI services.

| Metric | Description | Direction | Example |
|---|---|---|---|
| `uptime_pct` | Percentage of time the service is available | Higher is better (`gte`) | 99.9 |
| `p50_latency_ms` | Median response latency in milliseconds | Lower is better (`lte`) | 100 |
| `p99_latency_ms` | 99th percentile latency in milliseconds | Lower is better (`lte`) | 500 |
| `accuracy_pct` | Percentage of correct/acceptable responses | Higher is better (`gte`) | 95 |
| `throughput_rpm` | Requests per minute capacity | Higher is better (`gte`) | 1000 |
| `error_rate_pct` | Percentage of requests resulting in errors | Lower is better (`lte`) | 0.1 |
| `time_to_first_byte_ms` | Time to first byte in milliseconds | Lower is better (`lte`) | 50 |
| `custom` | User-defined metric (requires `custom_name`) | Any | -- |

---

## Comparison Operators

Each metric target is evaluated using one of four comparison operators:

| Operator | Meaning | Use case |
|---|---|---|
| `gte` | Greater than or equal to | Uptime, accuracy, throughput |
| `lte` | Less than or equal to | Latency, error rate, TTFB |
| `eq` | Exactly equal to | Version pinning, exact config |
| `between` | Within a range | Temperature, batch size |

---

## Metric Definition

Each SLA metric is defined as a structured object with a target value, comparison operator, and optional measurement and penalty configuration.

```typescript
interface SLAMetric {
  name: SLAMetricName;           // One of the 8 metric types
  target: number;                // Target value
  comparison: 'gte' | 'lte' | 'eq' | 'between';

  // Optional: how the metric is measured
  measurement_method?: 'rolling_average' | 'percentile' | 'absolute' | 'sampled';
  measurement_window?: string;   // e.g., "1h", "24h", "7d"

  // Optional: per-violation penalty deducted from escrow
  penalty_per_violation?: {
    amount: string;              // e.g., "0.50"
    currency: string;            // e.g., "USDC"
    max_penalties_per_window?: number;
  };

  custom_name?: string;          // Required when name is "custom"
}
```

**Measurement methods:**

| Method | Description |
|---|---|
| `rolling_average` | Average value over the measurement window. Default. |
| `percentile` | Percentile-based measurement (e.g., p99 latency). |
| `absolute` | Every individual observation must meet the target. |
| `sampled` | Random sampling within the window. |

---

## SLA Requirement

An SLA requirement bundles multiple metrics together with a dispute resolution method:

```typescript
interface SLARequirement {
  metrics: SLAMetric[];
  dispute_resolution?: {
    method: 'automatic_escrow' | 'lockstep_verification' | 'timeout_release' | 'manual_arbitration';
    timeout_hours?: number;
    arbitrator?: string;          // DID of the arbitrator (for manual_arbitration)
  };
}
```

---

## Dispute Resolution Methods

| Method | Description |
|---|---|
| `automatic_escrow` | Penalties deducted automatically from escrow based on `penalty_per_violation` |
| `lockstep_verification` | Lockstep behavioral testing framework verifies SLA compliance |
| `timeout_release` | Funds released to seller after timeout if no dispute is filed |
| `manual_arbitration` | A third-party arbitrator agent resolves the dispute |

---

## SLA Templates

The SDK provides pre-built templates via `SLA_TEMPLATES` for common AI service categories. These encode industry-standard quality targets so sellers do not need to define metrics from scratch.

### `inference_realtime`

For latency-sensitive, synchronous inference workloads (chatbots, real-time classification, streaming).

| Metric | Target | Comparison |
|---|---|---|
| `p99_latency_ms` | 500 | `lte` |
| `uptime_pct` | 99.9 | `gte` |
| `accuracy_pct` | 95 | `gte` |

Dispute resolution: `lockstep_verification`, 24h timeout.

### `inference_batch`

For high-throughput, asynchronous batch processing (embeddings, bulk classification).

| Metric | Target | Comparison |
|---|---|---|
| `throughput_rpm` | 1000 | `gte` |
| `accuracy_pct` | 97 | `gte` |
| `error_rate_pct` | 1 | `lte` |

Dispute resolution: `lockstep_verification`, 48h timeout.

### `data_processing`

For ETL pipelines, data enrichment, and transformation workloads.

| Metric | Target | Comparison |
|---|---|---|
| `throughput_rpm` | 500 | `gte` |
| `uptime_pct` | 99.5 | `gte` |
| `error_rate_pct` | 2 | `lte` |

Dispute resolution: `automatic_escrow`, 24h timeout.

### `code_generation`

For code completion, review, and generation services.

| Metric | Target | Comparison |
|---|---|---|
| `p99_latency_ms` | 5000 | `lte` |
| `accuracy_pct` | 90 | `gte` |
| `uptime_pct` | 99 | `gte` |

Dispute resolution: `lockstep_verification`, 24h timeout.

### `translation`

For language translation and localization services.

| Metric | Target | Comparison |
|---|---|---|
| `accuracy_pct` | 95 | `gte` |
| `p99_latency_ms` | 3000 | `lte` |
| `uptime_pct` | 99 | `gte` |

Dispute resolution: `lockstep_verification`, 24h timeout.

### Usage

```typescript
import { SLA_TEMPLATES } from '@ophir/sdk';

// Use a template directly
const sla = SLA_TEMPLATES.inference_realtime();

// Or customize it
const customSla = {
  ...SLA_TEMPLATES.inference_realtime(),
  metrics: [
    ...SLA_TEMPLATES.inference_realtime().metrics,
    {
      name: 'error_rate_pct' as const,
      target: 0.5,
      comparison: 'lte' as const,
      penalty_per_violation: {
        amount: '1.00',
        currency: 'USDC',
        max_penalties_per_window: 10,
      },
    },
  ],
};
```

---

## Comparing SLAs

The SDK provides `compareSLAs()` to evaluate two SLA offers metric-by-metric. This is useful for buyers deciding between competing quotes.

```typescript
import { SLA_TEMPLATES, compareSLAs } from '@ophir/sdk';

const sellerA = SLA_TEMPLATES.inference_realtime();
const sellerB = {
  metrics: [
    { name: 'p99_latency_ms', target: 300, comparison: 'lte' },
    { name: 'uptime_pct', target: 99.95, comparison: 'gte' },
    { name: 'accuracy_pct', target: 94, comparison: 'gte' },
  ],
  dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
};

const result = compareSLAs(sellerA, sellerB);

console.log(result.winner);  // "b" — Seller B wins on more metrics

for (const detail of result.details) {
  console.log(`${detail.metric}: A=${detail.a_value}, B=${detail.b_value}, better=${detail.better}`);
}
// p99_latency_ms: A=500, B=300, better=b    (lower is better)
// uptime_pct:     A=99.9, B=99.95, better=b  (higher is better)
// accuracy_pct:   A=95, B=94, better=a        (higher is better)
```

The comparison respects metric direction: for `lte` metrics (latency, error rate), lower values win. For `gte` metrics (uptime, accuracy, throughput), higher values win. The overall winner is determined by which side wins on more individual metrics.

**Return type:**

```typescript
interface SLAComparisonResult {
  winner: 'a' | 'b' | 'tie';
  details: Array<{
    metric: string;
    a_value: number;
    b_value: number;
    better: 'a' | 'b' | 'tie';
  }>;
}
```

---

## Validating SLA Requirements

The `meetsSLARequirements()` function checks whether a seller's offered SLA satisfies a buyer's required SLA. It returns a boolean result and a list of gaps for any unmet requirements.

```typescript
import { SLA_TEMPLATES, meetsSLARequirements } from '@ophir/sdk';

const buyerRequires = {
  metrics: [
    { name: 'p99_latency_ms', target: 400, comparison: 'lte' },
    { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
    { name: 'accuracy_pct', target: 96, comparison: 'gte' },
  ],
};

const sellerOffers = SLA_TEMPLATES.inference_realtime();
// p99: 500ms, uptime: 99.9%, accuracy: 95%

const result = meetsSLARequirements(sellerOffers, buyerRequires);

console.log(result.meets);  // false

for (const gap of result.gaps) {
  console.log(`${gap.metric}: required=${gap.required}, offered=${gap.offered}, gap=${gap.gap}`);
}
// p99_latency_ms: required=400, offered=500, gap=100
// accuracy_pct:   required=96, offered=95, gap=1
```

The function evaluates each required metric against the offered value using the metric's comparison operator. If the offered SLA is missing a metric entirely, the gap is reported with `offered: 0`.

**Return type:**

```typescript
interface SLAMeetsResult {
  meets: boolean;
  gaps: Array<{
    metric: string;
    required: number;
    offered: number;
    gap: number;
  }>;
}
```

---

## Example: Full SLA with Penalties

A complete SLA definition with measurement configuration and penalty structures:

```json
{
  "metrics": [
    {
      "name": "uptime_pct",
      "target": 99.95,
      "comparison": "gte",
      "measurement_method": "rolling_average",
      "measurement_window": "24h",
      "penalty_per_violation": {
        "amount": "1.00",
        "currency": "USDC",
        "max_penalties_per_window": 5
      }
    },
    {
      "name": "p99_latency_ms",
      "target": 300,
      "comparison": "lte",
      "measurement_method": "percentile",
      "measurement_window": "1h"
    },
    {
      "name": "accuracy_pct",
      "target": 96,
      "comparison": "gte",
      "measurement_method": "sampled",
      "measurement_window": "24h",
      "penalty_per_violation": {
        "amount": "0.50",
        "currency": "USDC",
        "max_penalties_per_window": 10
      }
    }
  ],
  "dispute_resolution": {
    "method": "lockstep_verification",
    "timeout_hours": 24
  }
}
```

When a dispute is filed, the on-chain [escrow program](./escrow.md) enforces penalties up to the configured `penalty_rate_bps` of the deposited amount. The `penalty_per_violation` structure in the SLA provides the off-chain logic for calculating how much to claim in a dispute.

---

## Further Reading

- [**How It Works**](./how-it-works.md) -- See how SLAs fit into the negotiation flow.
- [**Solana Escrow**](./escrow.md) -- On-chain penalty enforcement via `dispute_escrow`.
- [**Identity**](./identity.md) -- Cryptographic signing of SLA commitments.
