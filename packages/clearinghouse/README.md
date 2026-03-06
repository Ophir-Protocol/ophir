# @ophirai/clearinghouse

Agentic Clearinghouse for the Ophir Agent Negotiation Protocol. Transforms bilateral escrow into multilateral netting with fractional margin based on Probability of Delivery (PoD) scoring.

## Installation

```bash
npm install @ophirai/clearinghouse @ophirai/protocol
```

## What it does

Traditional escrow locks 100% of the agreement value. The clearinghouse uses an agent's track record to reduce that to as low as 5%:

- **New agent** (no history): 100% margin required
- **50 agreements, 95% SLA compliance**: ~10% margin
- **99th percentile agent**: ~5% margin

Circular debts between agents are automatically detected and cancelled (multilateral netting), further reducing locked capital.

## Quick start

```typescript
import { ClearinghouseManager } from '@ophirai/clearinghouse';

const clearinghouse = new ClearinghouseManager({
  min_margin_rate: 0.05,            // 5% floor
  max_exposure_per_agent: 1_000_000, // $1M max net exposure
  netting_interval_ms: 60_000,       // run netting every minute
  insurance_fund_bps: 10,            // 0.1% of netted volume
});

// Assess margin for an agreement
const assessment = clearinghouse.assessMargin(
  { agreement_id: 'agr_1', buyer_id: 'did:key:buyer', seller_id: 'did:key:seller' },
  10_000, // $10,000 agreement
);

console.log(assessment.required_deposit);  // e.g. 500 (5%) for proven agents
console.log(assessment.savings);           // e.g. 9500 saved vs 100% escrow
```

## Components

### PoD Oracle

Computes Probability of Delivery scores from 8 SLA metrics:

```typescript
import { PoDOracle } from '@ophirai/clearinghouse';

const oracle = new PoDOracle();

const score = oracle.computeScore('did:key:agent', completedAgreements);
// score.score: 0.0-1.0 (delivery reliability)
// score.margin_rate: 0.05-1.0 (required collateral fraction)
// score.confidence: 0.0-1.0 (data backing, max at 50 agreements)

const risk = oracle.assessRisk('did:key:agent');
// risk.risk_tier: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
```

**Metric weights**: uptime (25%), accuracy (20%), p99 latency (15%), error rate (15%), throughput (10%), p50 latency (5%), TTFB (5%), custom (5%).

### Netting Engine

Graph-based multilateral netting using DFS cycle detection:

```typescript
import { NettingEngine } from '@ophirai/clearinghouse';

const engine = new NettingEngine();

// A owes B $10, B owes C $15, C owes A $8
engine.addObligation({ id: '1', from_agent: 'A', to_agent: 'B', amount: 10000, agreement_id: 'agr_1', created_at: new Date().toISOString() });
engine.addObligation({ id: '2', from_agent: 'B', to_agent: 'C', amount: 15000, agreement_id: 'agr_2', created_at: new Date().toISOString() });
engine.addObligation({ id: '3', from_agent: 'C', to_agent: 'A', amount: 8000, agreement_id: 'agr_3', created_at: new Date().toISOString() });

const results = engine.runNetting();
// Nets $8000 from cycle, leaving A->B=$2000, B->C=$7000
// results[0].compression_ratio = 0.727 (72.7% capital freed)
```

### Clearinghouse Manager

Orchestrates PoD Oracle + Netting Engine with circuit breakers and default handling:

```typescript
const clearinghouse = new ClearinghouseManager();

// Margin assessment
clearinghouse.assessMargin(agreement, amount);

// Obligation lifecycle
clearinghouse.registerObligation(agreementId, from, to, amount);
clearinghouse.settleObligation(agreementId);

// Risk management
clearinghouse.checkCircuitBreaker(agentId);  // true if over limit
clearinghouse.handleDefault(agentId, agreementId, amount);  // slash + degrade

// Periodic netting
clearinghouse.startPeriodicNetting();
const results = clearinghouse.runNettingCycle();
clearinghouse.stopPeriodicNetting();
```

## SDK Integration

Pass a `ClearinghouseManager` to `BuyerAgent` or `SellerAgent`:

```typescript
import { BuyerAgent } from '@ophirai/sdk';
import { ClearinghouseManager } from '@ophirai/clearinghouse';

const buyer = new BuyerAgent({
  endpoint: 'http://localhost:3002',
  clearinghouse: new ClearinghouseManager(),
});

// acceptQuote() now automatically:
// 1. Computes margin via PoD Oracle
// 2. Transitions session to MARGIN_ASSESSED
// 3. Checks circuit breaker
// 4. Registers obligation for netting
const agreement = await buyer.acceptQuote(bestQuote);
const session = buyer.getSession(bestQuote.rfq_id);
console.log(session.getMarginAssessment());
```

## Protocol States

The clearinghouse adds `MARGIN_ASSESSED` to the negotiation FSM:

```
ACCEPTED -> MARGIN_ASSESSED -> ESCROWED -> ACTIVE -> COMPLETED
```

## API

| Export | Description |
|---|---|
| `PoDOracle` | SLA-based credit scoring and margin calculation |
| `NettingEngine` | Graph-based multilateral obligation netting |
| `ClearinghouseManager` | Orchestrator with circuit breaker and default handling |
| Types | `PoDScore`, `MarginAssessment`, `NettingResult`, `Obligation`, `AgentExposure`, etc. |

## License

MIT
