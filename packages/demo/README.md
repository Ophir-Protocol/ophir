# @ophir/demo

Interactive demonstration of the Ophir Agent Negotiation Protocol. Two AI agents negotiate a GPU inference contract in real-time, walking through the full protocol lifecycle with colored terminal output.

## Run the demo

```bash
npx ophir-demo
```

## What the demo shows

The demo runs a complete negotiation between a buyer and seller agent, demonstrating each protocol phase:

| Step | Phase | Description |
|---|---|---|
| 1 | Seller setup | Seller starts on port 3001 offering GPU inference at $0.005/request |
| 2 | Buyer setup | Buyer starts on port 3002 with a $0.01/request budget |
| 3 | RFQ | Buyer broadcasts requirements: vision model, p99 latency under 500ms |
| 4 | Quote | Seller responds at $0.005/request with 99.95% uptime, p99 under 300ms |
| 5 | Counter | Buyer counter-offers at $0.003/request citing volume commitment |
| 6 | Accept | Seller revises to $0.004/request; buyer accepts |
| 7 | Agreement | Both parties sign; agreement hash is generated |
| 8 | Escrow | USDC deposited to Solana PDA (simulated) |
| 9 | Summary | Before/after comparison showing 60% cost savings with SLA guarantees |

The demo also prints the minimal buyer and seller code examples (approximately 15 lines each) to show how little code is needed to participate in the protocol.

## Output

The demo uses colored terminal output to distinguish between:
- Buyer actions and messages
- Seller actions and messages
- Protocol events (signatures, hashes, state transitions)
- Final agreement summary

## Documentation

- [BuyerAgent API reference](../docs/sdk/buyer.md)
- [SellerAgent API reference](../docs/sdk/seller.md)
- [Protocol specification](../docs/protocol/specification.md)
