# Ophir Lockstep Specification v1.0

**Status**: Draft
**Authors**: Ophir Contributors
**Date**: 2026-03-05

## Abstract

This specification defines the Lockstep integration layer for the Ophir Agent Negotiation Protocol. Lockstep provides continuous behavioral verification of SLA compliance between agents, bridging the gap between off-chain agreement terms and on-chain escrow enforcement. It defines how SLA metrics are monitored, how violations are detected and attested, and how disputes are escalated to the Solana escrow program.

## 1. Overview

After two agents finalize an Ophir agreement (dual-signed, with an optional Solana escrow), the **seller** begins delivering the service and the **buyer** begins consuming it. Lockstep sits between these two phases, continuously verifying that the seller's actual performance matches the SLA terms committed in the agreement.

```
Agreement Signed → Escrow Funded → Lockstep Monitoring Begins
                                         │
                                         ├── Compliant → Service Continues → Escrow Released
                                         │
                                         └── Violation Detected → Evidence Attested → Dispute Filed
                                                                                         │
                                                                                         └── Escrow Penalty Applied
```

## 2. Lockstep Verification Spec

When an agreement is finalized, both parties independently derive a **Lockstep Verification Spec** from the agreement's SLA terms. This spec is deterministic — given the same agreement, both parties produce byte-identical specs.

### 2.1 Spec Schema

```typescript
interface LockstepVerificationSpec {
  // Spec format version
  version: "1.0";

  // Agreement binding
  agreement_id: string;        // UUID from the Ophir agreement
  agreement_hash: string;      // SHA-256 hash from the Ophir agreement

  // Parties
  buyer: string;               // did:key of the buyer
  seller: string;              // did:key of the seller

  // Behavioral checks derived from SLA metrics
  behavioral_checks: BehavioralCheck[];

  // How to handle violations
  dispute_resolution: {
    method: "automatic_escrow" | "lockstep_verification" | "timeout_release" | "manual_arbitration";
    timeout_hours?: number;
    arbitrator?: string;       // did:key of arbitrator agent, if manual
  };

  // Monitoring configuration
  monitoring: {
    mode: "continuous" | "periodic" | "on_demand";
    interval_seconds?: number; // For periodic mode (default: 60)
    retention_hours: number;   // How long to retain metric samples (default: 168 = 7 days)
  };

  // Escrow binding (if funded)
  escrow?: {
    network: "solana";
    address: string;           // PDA address (base58)
    penalty_rate_bps: number;  // Basis points for penalty calculation
  };
}
```

### 2.2 Behavioral Check

Each SLA metric maps to exactly one behavioral check:

```typescript
interface BehavioralCheck {
  // Metric identification
  metric: string;              // e.g. "p99_latency_ms", "uptime_pct", "accuracy_pct"
  custom_name?: string;        // For "custom" metrics

  // Threshold
  operator: "lte" | "gte" | "eq";
  threshold: number;

  // Measurement
  measurement_method: "rolling_average" | "percentile" | "count" | "rate" | "instant";
  measurement_window: string;  // ISO 8601 duration: "PT1H", "PT5M", "P1D"
  min_samples: number;         // Minimum samples before check is valid (default: 10)

  // Violation policy
  violation_policy: {
    consecutive_failures: number;  // Failures before violation is raised (default: 3)
    cooldown_seconds: number;      // Minimum time between violations for same metric (default: 300)
  };

  // Penalty
  penalty?: {
    amount: string;            // Decimal string (e.g. "0.50")
    currency: string;          // e.g. "USDC"
    cap?: string;              // Maximum total penalty (optional)
  };
}
```

### 2.3 Derivation from Ophir SLA

The spec is derived deterministically from the agreement:

```
For each metric in agreement.final_terms.sla.metrics:
  behavioral_check.metric         = metric.name
  behavioral_check.operator       = metric.comparison
  behavioral_check.threshold      = metric.target
  behavioral_check.measurement_method = metric.measurement_method ?? "rolling_average"
  behavioral_check.measurement_window = metric.measurement_window ?? "PT1H"
  behavioral_check.min_samples    = 10
  behavioral_check.violation_policy.consecutive_failures = 3
  behavioral_check.violation_policy.cooldown_seconds = 300
  behavioral_check.penalty        = metric.penalty_per_violation ?? null
```

## 3. Metric Collection

### 3.1 Collection Points

Metrics are collected at the **buyer side** (the consumer of the service). The buyer instruments its calls to the seller and records:

| Metric | Collection Method |
|--------|------------------|
| `uptime_pct` | Track successful vs failed requests over the measurement window |
| `p50_latency_ms` | Record request-response latency, compute 50th percentile |
| `p99_latency_ms` | Record request-response latency, compute 99th percentile |
| `accuracy_pct` | Application-defined accuracy check on responses |
| `throughput_rpm` | Count successful requests per minute |
| `error_rate_pct` | Track error responses as percentage of total |
| `time_to_first_byte_ms` | Record time from request sent to first response byte |
| `custom` | Application-defined measurement function |

### 3.2 Sample Format

```typescript
interface MetricSample {
  metric: string;
  value: number;
  timestamp: string;           // ISO 8601
  agreement_id: string;
  measurement_window: string;  // ISO 8601 duration
  sample_count: number;        // Number of raw observations in this sample
}
```

### 3.3 Local Metric Store

The buyer maintains a local time-series store of metric samples. The SDK provides a `MetricCollector` class:

```typescript
class MetricCollector {
  // Record a raw observation (e.g. a single request latency)
  record(metric: string, value: number): void;

  // Compute the current aggregate for a metric over its measurement window
  aggregate(metric: string, method: MeasurementMethod): number;

  // Get all samples within a time range
  samples(metric: string, from: Date, to: Date): MetricSample[];

  // Check all behavioral checks and return violations
  evaluate(spec: LockstepVerificationSpec): Violation[];
}
```

## 4. Violation Detection

### 4.1 Evaluation Loop

The buyer runs an evaluation loop according to the monitoring mode:

- **continuous**: Evaluate after every request
- **periodic**: Evaluate every `interval_seconds` (default: 60s)
- **on_demand**: Evaluate only when explicitly triggered

### 4.2 Violation Record

When a behavioral check fails:

```typescript
interface Violation {
  violation_id: string;        // UUID
  agreement_id: string;
  agreement_hash: string;
  metric: string;
  threshold: number;
  observed: number;
  operator: string;
  measurement_window: string;
  sample_count: number;
  timestamp: string;           // ISO 8601
  consecutive_count: number;   // How many consecutive failures

  // Evidence
  samples: MetricSample[];    // Raw samples within the measurement window
  evidence_hash: string;       // SHA-256 of canonicalized samples array
}
```

### 4.3 Violation Escalation

A violation is escalated to a dispute when `consecutive_count >= violation_policy.consecutive_failures`:

1. Buyer computes `evidence_hash = SHA-256(JCS(samples))`
2. Buyer creates a signed `Violation` record
3. Buyer sends `negotiate/dispute` to the seller with the violation evidence
4. If escrow is funded, buyer calls `dispute_escrow` on-chain with the evidence hash

## 5. Attestation Protocol

### 5.1 Mutual Attestation

For contested violations, Lockstep supports mutual attestation where both parties submit their view of the metrics:

```
Buyer claims: p99_latency = 750ms (violation, threshold is 500ms)
Seller claims: p99_latency = 450ms (no violation)

Resolution:
  1. Both parties submit signed MetricSample arrays
  2. Evidence hashes are compared
  3. If escrow exists: dispute_escrow is called, penalty splits the difference
  4. If no escrow: violation is recorded but no financial action
```

### 5.2 Third-Party Attestation

For `manual_arbitration` disputes, a third-party arbitrator agent can be designated:

```typescript
interface ArbitrationRequest {
  dispute_id: string;
  agreement_id: string;
  buyer_evidence: { samples: MetricSample[]; evidence_hash: string; signature: string };
  seller_evidence: { samples: MetricSample[]; evidence_hash: string; signature: string };
  spec: LockstepVerificationSpec;
}

interface ArbitrationResult {
  dispute_id: string;
  ruling: "buyer_wins" | "seller_wins" | "split";
  split_bps?: number;          // If split, buyer's share in basis points
  reasoning: string;
  arbitrator_signature: string; // Ed25519 signature of the ruling
}
```

## 6. Lockstep Service API

### 6.1 Endpoints

The Lockstep verification service exposes these endpoints:

```
POST   /v1/monitors                 Create a monitoring session
GET    /v1/monitors/:id             Get monitoring session status
GET    /v1/monitors/:id/compliance  Check current compliance
POST   /v1/monitors/:id/samples     Submit metric samples
POST   /v1/monitors/:id/dispute     Trigger a dispute
DELETE /v1/monitors/:id             Stop monitoring
```

### 6.2 Create Monitor

```
POST /v1/monitors
Content-Type: application/json

{
  "monitoring_id": "mon_<agreement_id>",
  "spec": { ... LockstepVerificationSpec ... },
  "buyer_signature": "base64...",
  "seller_signature": "base64..."  // Optional: seller can co-sign to acknowledge monitoring
}

Response 201:
{
  "monitoring_id": "mon_<agreement_id>",
  "status": "active",
  "created_at": "2026-03-05T12:00:00Z"
}
```

### 6.3 Submit Samples

```
POST /v1/monitors/:id/samples
Content-Type: application/json

{
  "samples": [
    { "metric": "p99_latency_ms", "value": 320, "timestamp": "...", "sample_count": 150 }
  ],
  "submitter": "did:key:...",
  "signature": "base64..."
}

Response 200:
{
  "accepted": 1,
  "current_compliance": { "compliant": true, "violations": [] }
}
```

### 6.4 Compliance Check

```
GET /v1/monitors/:id/compliance

Response 200:
{
  "compliant": false,
  "violations": [
    {
      "metric": "p99_latency_ms",
      "threshold": 500,
      "observed": 720,
      "consecutive_count": 3,
      "first_failure": "2026-03-05T12:01:00Z",
      "latest_failure": "2026-03-05T12:03:00Z"
    }
  ],
  "last_checked": "2026-03-05T12:03:30Z",
  "samples_count": 450
}
```

## 7. SDK Integration

### 7.1 MetricCollector

```typescript
import { MetricCollector, LockstepMonitor } from '@ophirai/sdk';

// Wrap service calls with metric collection
const collector = new MetricCollector(agreement);

// Record observations as you make service calls
const start = Date.now();
const result = await callSellerService(request);
collector.record('p99_latency_ms', Date.now() - start);
collector.record('accuracy_pct', validateAccuracy(result) ? 100 : 0);

// Periodic compliance evaluation
const monitor = new LockstepMonitor({ collector });
await monitor.startMonitoring(agreement);

// Check compliance
const compliance = await monitor.checkCompliance(monitoringId);
if (!compliance.compliant) {
  for (const violation of compliance.violations) {
    if (violation.consecutive_count >= 3) {
      // Auto-dispute via escrow
      await buyer.dispute(agreement, {
        metric: violation.metric,
        threshold: violation.threshold,
        observed: violation.observed,
        evidence_hash: violation.evidence_hash,
        samples: violation.samples,
      });
    }
  }
}
```

### 7.2 Automatic Dispute Escalation

```typescript
// Configure auto-escalation
monitor.onViolation(async (violation, agreement) => {
  if (agreement.escrow) {
    // Automatic on-chain dispute
    const escrow = new EscrowManager(escrowConfig);
    await escrow.dispute(
      agreement.escrow.address,
      violation.evidence_hash,
      buyerKeypair,
    );
  } else {
    // Off-chain dispute notification
    await buyer.dispute(agreement, violation);
  }
});
```

## 8. Self-Hosted vs Hosted Lockstep

### 8.1 Self-Hosted Mode

Agents can run the full Lockstep verification loop locally without any external service:

- MetricCollector records observations locally
- Evaluation loop runs in-process
- Violations trigger disputes directly via the Ophir SDK
- Evidence hashes are computed locally for on-chain disputes

### 8.2 Hosted Lockstep Service

A hosted Lockstep service provides:

- Persistent metric storage across agent restarts
- Third-party attestation (neutral observer of metrics)
- Historical compliance dashboards
- Alert webhooks for violations
- Arbitration coordination

### 8.3 Decentralized Lockstep

Future: Lockstep verification can be run on a decentralized oracle network (e.g. Chainlink Functions, Switchboard) where multiple nodes independently verify metrics and reach consensus on violations before triggering on-chain disputes.

## 9. Wire Format

### 9.1 Lockstep JSON-RPC Methods

Lockstep extends the Ophir protocol with additional methods:

| Method | Direction | Description |
|--------|-----------|-------------|
| `lockstep/register` | Buyer → Lockstep | Register agreement for monitoring |
| `lockstep/submit` | Buyer → Lockstep | Submit metric samples |
| `lockstep/compliance` | Buyer → Lockstep | Request compliance check |
| `lockstep/attest` | Seller → Lockstep | Submit counter-attestation |
| `lockstep/arbitrate` | Arbitrator → Lockstep | Submit arbitration ruling |

### 9.2 Message Signing

All Lockstep messages follow Ophir signing conventions:
- JCS canonicalization (RFC 8785)
- Ed25519 detached signatures
- `did:key` identity
- Replay protection via message IDs

## 10. Security Considerations

### 10.1 Metric Manipulation

**Threat**: Buyer fabricates metrics to trigger false disputes.
**Mitigation**: Seller can submit counter-attestation with their own observations. For high-value agreements, use third-party attestation or decentralized oracle verification.

### 10.2 Selective Reporting

**Threat**: Buyer omits favorable samples to inflate violation metrics.
**Mitigation**: `min_samples` requirement ensures sufficient data. The `consecutive_failures` policy prevents one-off spikes from triggering disputes. Sellers can monitor their own metrics and preemptively submit attestations.

### 10.3 Evidence Integrity

**Threat**: Tampering with evidence after the fact.
**Mitigation**: Evidence hash (SHA-256 of JCS-canonicalized samples) is submitted on-chain with the dispute. The hash is immutable once recorded.

### 10.4 Replay Attacks

**Threat**: Replaying old violation evidence for new disputes.
**Mitigation**: Each violation has a unique `violation_id` and timestamp. The escrow program tracks dispute status and only allows one active dispute per escrow.

## 11. Implementation Roadmap

### Phase 1: Local Monitoring (Current)
- [x] `LockstepMonitor` class with best-effort remote registration
- [x] `agreementToLockstepSpec()` conversion
- [x] `slaToLockstepSpec()` conversion
- [ ] `MetricCollector` class for local observation recording
- [ ] Evaluation loop with violation detection
- [ ] Auto-dispute escalation to Ophir SDK

### Phase 2: Hosted Service
- [ ] Lockstep verification API server
- [ ] Persistent metric storage (TimescaleDB / ClickHouse)
- [ ] Compliance dashboard
- [ ] Webhook alerts

### Phase 3: Decentralized Verification
- [ ] Oracle network integration (Switchboard / Chainlink)
- [ ] Multi-node consensus on violations
- [ ] Automated on-chain dispute with oracle attestation

## Appendix A: Metric Measurement Methods

| Method | Description | Use For |
|--------|------------|---------|
| `rolling_average` | Mean value over the measurement window | uptime_pct, accuracy_pct, error_rate_pct |
| `percentile` | Nth percentile over the measurement window | p50_latency_ms, p99_latency_ms |
| `count` | Total count over the measurement window | throughput_rpm |
| `rate` | Rate of change over the measurement window | error_rate_pct |
| `instant` | Most recent value | time_to_first_byte_ms |

## Appendix B: Example Full Verification Spec

```json
{
  "version": "1.0",
  "agreement_id": "550e8400-e29b-41d4-a716-446655440000",
  "agreement_hash": "a1b2c3d4e5f6...",
  "buyer": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "seller": "did:key:z6MkpTHR8VNs5xQVwZz2YcS6YtMxCp5UsFMLNm4bDz7mT1tF",
  "behavioral_checks": [
    {
      "metric": "p99_latency_ms",
      "operator": "lte",
      "threshold": 500,
      "measurement_method": "percentile",
      "measurement_window": "PT1H",
      "min_samples": 10,
      "violation_policy": { "consecutive_failures": 3, "cooldown_seconds": 300 },
      "penalty": { "amount": "0.50", "currency": "USDC", "cap": "50.00" }
    },
    {
      "metric": "uptime_pct",
      "operator": "gte",
      "threshold": 99.9,
      "measurement_method": "rolling_average",
      "measurement_window": "P1D",
      "min_samples": 100,
      "violation_policy": { "consecutive_failures": 1, "cooldown_seconds": 3600 },
      "penalty": { "amount": "5.00", "currency": "USDC", "cap": "100.00" }
    }
  ],
  "dispute_resolution": {
    "method": "lockstep_verification",
    "timeout_hours": 24
  },
  "monitoring": {
    "mode": "periodic",
    "interval_seconds": 60,
    "retention_hours": 168
  },
  "escrow": {
    "network": "solana",
    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "penalty_rate_bps": 1000
  }
}
```
