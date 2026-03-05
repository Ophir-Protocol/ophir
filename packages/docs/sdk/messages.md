# Message types

Ophir uses six message types, each transported as a JSON-RPC 2.0 request over HTTPS. All six message types are signed with Ed25519 using JCS canonicalization.

All examples below use a consistent negotiation flow: a single RFQ, quote, counter, accept, reject, and dispute sharing the same `rfq_id`.

---

## Overview

| Method | Direction | Signed | Description |
|---|---|---|---|
| `negotiate/rfq` | Buyer to Seller | Yes | Request for Quote |
| `negotiate/quote` | Seller to Buyer | Yes | Quote with pricing and SLA offer |
| `negotiate/counter` | Either to Either | Yes | Counter-offer with modified terms |
| `negotiate/accept` | Buyer to Seller | Yes (dual) | Accept terms and create agreement |
| `negotiate/reject` | Either to Either | Yes | Terminate the negotiation |
| `negotiate/dispute` | Buyer to Seller | Yes | File an SLA violation claim |

All six message types carry Ed25519 signatures. The sender signs the canonicalized (JCS) params so that receivers can verify authenticity before processing.

---

## negotiate/rfq

Buyer broadcasts a Request for Quote to one or more sellers. This message initiates a new negotiation session.

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/rfq",
  "id": "msg-001",
  "params": {
    "rfq_id": "550e8400-e29b-41d4-a716-446655440000",
    "buyer": {
      "agent_id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      "endpoint": "http://buyer.example.com:3002"
    },
    "service": {
      "category": "inference",
      "description": "Vision model inference",
      "requirements": {
        "model": "vision",
        "min_accuracy": 0.95
      }
    },
    "budget": {
      "max_price_per_unit": "0.01",
      "currency": "USDC",
      "unit": "request",
      "total_budget": "100.00"
    },
    "sla_requirements": {
      "metrics": [
        { "name": "p99_latency_ms", "target": 500, "comparison": "lte" },
        { "name": "uptime_pct", "target": 99.9, "comparison": "gte" }
      ]
    },
    "negotiation_style": "rfq",
    "max_rounds": 5,
    "expires_at": "2026-03-04T12:05:00.000Z",
    "accepted_payments": [
      { "network": "solana", "token": "USDC" }
    ],
    "signature": "VGhpcyBpcyBhIGJhc2U2NCBlbmNvZGVkIEVkMjU1MTkgc2lnbmF0dXJl..."
  }
}
```

**Fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `rfq_id` | `string` | Yes | Unique UUID for this RFQ |
| `buyer` | `AgentInfo` | Yes | Buyer's `did:key` identifier and callback endpoint |
| `service` | `ServiceRequirement` | Yes | Category, description, and capability requirements |
| `budget` | `BudgetConstraint` | Yes | Maximum price per unit, currency, unit, and optional total budget |
| `sla_requirements` | `SLARequirement` | No | Desired SLA metrics with targets |
| `negotiation_style` | `string` | No | Always `"rfq"` in the current protocol version |
| `max_rounds` | `number` | No | Maximum counter-offer rounds (default: 5) |
| `expires_at` | `string` | Yes | ISO 8601 timestamp; sellers must respond before this time |
| `accepted_payments` | `PaymentMethod[]` | No | Accepted payment networks and tokens |
| `signature` | `string` | Yes | Base64-encoded Ed25519 signature over the canonicalized unsigned params |

---

## negotiate/quote

Seller responds to an RFQ with pricing, SLA guarantees, and optional volume discounts. This message is signed.

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/quote",
  "id": "msg-002",
  "params": {
    "quote_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "rfq_id": "550e8400-e29b-41d4-a716-446655440000",
    "seller": {
      "agent_id": "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WkT8t9grpQ",
      "endpoint": "http://seller.example.com:3001"
    },
    "pricing": {
      "price_per_unit": "0.0050",
      "currency": "USDC",
      "unit": "request",
      "pricing_model": "fixed",
      "volume_discounts": [
        { "min_units": 1000, "price_per_unit": "0.0040" },
        { "min_units": 5000, "price_per_unit": "0.0035" }
      ]
    },
    "sla_offered": {
      "metrics": [
        { "name": "p99_latency_ms", "target": 300, "comparison": "lte" },
        { "name": "uptime_pct", "target": 99.95, "comparison": "gte" },
        { "name": "accuracy_pct", "target": 96, "comparison": "gte" }
      ],
      "dispute_resolution": {
        "method": "lockstep_verification",
        "timeout_hours": 24
      }
    },
    "expires_at": "2026-03-04T12:02:00.000Z",
    "signature": "VGhpcyBpcyBhIGJhc2U2NCBlbmNvZGVkIEVkMjU1MTkgc2lnbmF0dXJl..."
  }
}
```

**Fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `quote_id` | `string` | Yes | Unique UUID for this quote |
| `rfq_id` | `string` | Yes | References the original RFQ |
| `seller` | `AgentInfo` | Yes | Seller's `did:key` identifier and endpoint |
| `pricing` | `PricingOffer` | Yes | Price per unit, currency, unit, model, and optional volume discounts |
| `sla_offered` | `SLARequirement` | No | SLA metrics the seller commits to, with dispute resolution terms |
| `expires_at` | `string` | Yes | ISO 8601 timestamp; quote is invalid after this time |
| `escrow_requirement` | `EscrowRequirement` | No | On-chain escrow deposit requirements |
| `signature` | `string` | Yes | Base64-encoded Ed25519 signature over the canonicalized unsigned params |

---

## negotiate/counter

Either party proposes modified terms. Counter-offers reference the message being countered and include only the fields being changed.

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/counter",
  "id": "msg-003",
  "params": {
    "counter_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "rfq_id": "550e8400-e29b-41d4-a716-446655440000",
    "in_response_to": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "round": 2,
    "from": {
      "agent_id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      "role": "buyer"
    },
    "modifications": {
      "price_per_unit": "0.003"
    },
    "justification": "Volume discount: 5000+ requests committed",
    "expires_at": "2026-03-04T12:04:00.000Z",
    "signature": "VGhpcyBpcyBhIGJhc2U2NCBlbmNvZGVkIEVkMjU1MTkgc2lnbmF0dXJl..."
  }
}
```

**Fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `counter_id` | `string` | Yes | Unique UUID for this counter-offer |
| `rfq_id` | `string` | Yes | References the original RFQ |
| `in_response_to` | `string` | Yes | UUID of the quote or counter being responded to |
| `round` | `number` | Yes | Current negotiation round (must not exceed `max_rounds`) |
| `from` | `{ agent_id, role }` | Yes | Sender's `did:key` and role (`"buyer"` or `"seller"`) |
| `modifications` | `object` | Yes | Fields to change (e.g., `price_per_unit`, SLA targets) |
| `justification` | `string` | No | Human-readable explanation for the counter-offer |
| `expires_at` | `string` | Yes | ISO 8601 timestamp; counter expires after this time |
| `signature` | `string` | Yes | Base64-encoded Ed25519 signature |

---

## negotiate/accept

Buyer accepts the negotiated terms and creates a dual-signed agreement. The `agreement_hash` cryptographically binds both parties to the final terms.

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/accept",
  "id": "msg-004",
  "params": {
    "agreement_id": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    "rfq_id": "550e8400-e29b-41d4-a716-446655440000",
    "accepting_message_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "final_terms": {
      "price_per_unit": "0.004",
      "currency": "USDC",
      "unit": "request",
      "sla": {
        "metrics": [
          { "name": "p99_latency_ms", "target": 300, "comparison": "lte" },
          { "name": "uptime_pct", "target": 99.95, "comparison": "gte" }
        ],
        "dispute_resolution": {
          "method": "lockstep_verification",
          "timeout_hours": 24
        }
      }
    },
    "agreement_hash": "a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1",
    "buyer_signature": "VGhpcyBpcyBhIGJhc2U2NCBlbmNvZGVkIEVkMjU1MTkgc2lnbmF0dXJl...",
    "seller_signature": "U2VsbGVyIHNpZ25hdHVyZSBmcm9tIHRoZSBvcmlnaW5hbCBxdW90ZQ..."
  }
}
```

**Fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `agreement_id` | `string` | Yes | Unique UUID for this agreement |
| `rfq_id` | `string` | Yes | References the original RFQ |
| `accepting_message_id` | `string` | Yes | UUID of the quote or counter being accepted |
| `final_terms` | `FinalTerms` | Yes | Agreed-upon price, currency, unit, SLA, and escrow terms |
| `agreement_hash` | `string` | Yes | Hex-encoded SHA-256 of JCS-canonicalized `final_terms` |
| `buyer_signature` | `string` | Yes | Buyer's base64-encoded Ed25519 signature |
| `seller_signature` | `string` | Yes | Seller's signature, carried forward from the accepted quote |

The `agreement_hash` is used as a seed for the Solana escrow PDA, cryptographically binding the on-chain escrow to the negotiated terms.

---

## negotiate/reject

Either party terminates the negotiation. Rejection is terminal -- the session cannot be resumed.

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/reject",
  "id": "msg-005",
  "params": {
    "rfq_id": "550e8400-e29b-41d4-a716-446655440000",
    "rejecting_message_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "reason": "Price exceeds budget constraints",
    "from": {
      "agent_id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
    },
    "signature": "VGhpcyBpcyBhIGJhc2U2NCBlbmNvZGVkIEVkMjU1MTkgc2lnbmF0dXJl..."
  }
}
```

**Fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `rfq_id` | `string` | Yes | References the original RFQ |
| `rejecting_message_id` | `string` | Yes | UUID of the message being rejected |
| `reason` | `string` | No | Human-readable rejection reason |
| `from` | `{ agent_id }` | Yes | Sender's `did:key` identifier |
| `signature` | `string` | Yes | Base64-encoded Ed25519 signature over the canonicalized unsigned params |

---

## negotiate/dispute

Buyer files an SLA violation claim against an active agreement. The dispute includes measurement evidence and optionally references a Lockstep verification report.

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/dispute",
  "id": "msg-006",
  "params": {
    "dispute_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "agreement_id": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    "filed_by": {
      "agent_id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      "role": "buyer"
    },
    "violation": {
      "sla_metric": "p99_latency_ms",
      "agreed_value": 300,
      "observed_value": 1200,
      "measurement_window": "2026-03-04T00:00:00Z/2026-03-04T01:00:00Z",
      "evidence_hash": "b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5",
      "evidence_url": "https://evidence.example.com/report/12345"
    },
    "requested_remedy": "escrow_release",
    "escrow_action": "freeze",
    "lockstep_report": {
      "verification_id": "ver-001",
      "result": "FAIL",
      "deviations": ["p99_latency_ms: 1200ms > 300ms target"]
    },
    "signature": "VGhpcyBpcyBhIGJhc2U2NCBlbmNvZGVkIEVkMjU1MTkgc2lnbmF0dXJl..."
  }
}
```

**Fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `dispute_id` | `string` | Yes | Unique UUID for this dispute |
| `agreement_id` | `string` | Yes | References the agreement being disputed |
| `filed_by` | `{ agent_id, role }` | Yes | Filer's `did:key` and role |
| `violation` | `ViolationEvidence` | Yes | SLA metric name, agreed vs. observed values, measurement window |
| `requested_remedy` | `string` | Yes | Desired outcome (e.g., `"escrow_release"`) |
| `escrow_action` | `string` | No | Immediate escrow action (e.g., `"freeze"`) |
| `lockstep_report` | `LockstepReport` | No | Automated verification report from Lockstep |
| `signature` | `string` | Yes | Base64-encoded Ed25519 signature |

**ViolationEvidence**

| Field | Type | Required | Description |
|---|---|---|---|
| `sla_metric` | `string` | Yes | Name of the violated metric (e.g., `p99_latency_ms`) |
| `agreed_value` | `number` | Yes | Target value from the agreement |
| `observed_value` | `number` | Yes | Measured value demonstrating the violation |
| `measurement_window` | `string` | Yes | ISO 8601 time interval (`start/end`) |
| `evidence_hash` | `string` | No | SHA-256 hash of the raw evidence data |
| `evidence_url` | `string` | No | URL where the full evidence can be retrieved |
