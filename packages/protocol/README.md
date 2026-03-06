# @ophir/protocol

Core protocol definitions for the Ophir Agent Negotiation Protocol. This package contains TypeScript types, Zod validation schemas, constants, and error codes shared by all Ophir packages.

## Installation

```bash
npm install @ophir/protocol
```

## Usage

```typescript
import {
  METHODS,
  DEFAULT_CONFIG,
  RFQParamsSchema,
  QuoteParamsSchema,
  CounterParamsSchema,
  AcceptParamsSchema,
  RejectParamsSchema,
  DisputeParamsSchema,
  OphirError,
  OphirErrorCode,
} from '@ophir/protocol';

import type {
  RFQParams,
  QuoteParams,
  CounterParams,
  AcceptParams,
  RejectParams,
  DisputeParams,
  FinalTerms,
  SLAMetricName,
  NegotiationState,
} from '@ophir/protocol';
```

### Validate an incoming message

```typescript
import { RFQParamsSchema, QuoteParamsSchema } from '@ophir/protocol';

// Throws ZodError if validation fails
const rfq = RFQParamsSchema.parse(incomingData);
const quote = QuoteParamsSchema.parse(incomingData);
```

### Access protocol constants

```typescript
import { METHODS, DEFAULT_CONFIG } from '@ophir/protocol';

METHODS.RFQ;       // "negotiate/rfq"
METHODS.QUOTE;     // "negotiate/quote"
METHODS.COUNTER;   // "negotiate/counter"
METHODS.ACCEPT;    // "negotiate/accept"
METHODS.REJECT;    // "negotiate/reject"
METHODS.DISPUTE;   // "negotiate/dispute"

DEFAULT_CONFIG.rfq_timeout_ms;      // 300000 (5 minutes)
DEFAULT_CONFIG.quote_timeout_ms;    // 120000 (2 minutes)
DEFAULT_CONFIG.counter_timeout_ms;  // 120000 (2 minutes)
DEFAULT_CONFIG.max_negotiation_rounds;  // 5
```

### Handle errors

```typescript
import { OphirError, OphirErrorCode } from '@ophir/protocol';

try {
  // ... protocol operation
} catch (err) {
  if (err instanceof OphirError) {
    console.error(err.code);     // e.g., "OPHIR_002"
    console.error(err.message);  // Human-readable description
    console.error(err.data);     // Optional structured context
  }
}
```

## What is included

### Types

TypeScript interfaces for every protocol message:

- `RFQParams`, `QuoteParams`, `CounterParams`, `AcceptParams`, `RejectParams`, `DisputeParams`
- `FinalTerms`, `AgentIdentity`, `ServiceRequirement`, `BudgetConstraint`
- `SLARequirement`, `SLAMetric`, `SLAMetricName`
- `PricingOffer`, `VolumeDiscount`, `EscrowRequirement`
- `ViolationEvidence`, `NegotiationState`

### Schemas

Zod validation schemas for runtime message validation:

- `RFQParamsSchema`, `QuoteParamsSchema`, `CounterParamsSchema`
- `AcceptParamsSchema`, `RejectParamsSchema`, `DisputeParamsSchema`

### Constants

- `METHODS` -- RPC method name constants
- `DEFAULT_CONFIG` -- Default timeouts, currency, escrow seeds, max rounds

### Errors

- `OphirErrorCode` -- Enum of all error codes (`OPHIR_001` through `OPHIR_504`)
- `OphirError` -- Typed error class with `code`, `message`, and optional `data`

Error code ranges:
- `OPHIR_001–006`: Message validation
- `OPHIR_100–104`: Negotiation
- `OPHIR_200–204`: Escrow
- `OPHIR_300–301`: Dispute
- `OPHIR_400–403`: Infrastructure
- `OPHIR_500–504`: Clearinghouse (margin, exposure, netting, circuit breaker, PoD)

### SLA metric types

```
uptime_pct | p50_latency_ms | p99_latency_ms | accuracy_pct |
throughput_rpm | error_rate_pct | time_to_first_byte_ms | custom
```

### State machine

```typescript
import { isValidTransition, isTerminalState, getValidNextStates } from '@ophirai/protocol';
```

```
IDLE → RFQ_SENT → QUOTES_RECEIVED → COUNTERING → ACCEPTED →
MARGIN_ASSESSED → ESCROWED → ACTIVE → COMPLETED
                                   ↘ DISPUTED → RESOLVED

Any non-terminal state → REJECTED (terminal)
```

12 states. Terminal: COMPLETED, REJECTED, RESOLVED.

## Documentation

- [Protocol specification](../docs/protocol/specification.md)
- [State machine](../docs/protocol/state-machine.md)
- [Message types](../docs/sdk/messages.md)
