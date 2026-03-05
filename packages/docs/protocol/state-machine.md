# State machine

Every Ophir negotiation session is governed by a finite state machine. The session transitions between states in response to protocol messages and on-chain events.

---

## States

| State | Terminal | Description |
|---|---|---|
| `IDLE` | No | Initial state before any message is sent |
| `RFQ_SENT` | No | Buyer has broadcast an RFQ to one or more sellers |
| `QUOTES_RECEIVED` | No | At least one quote has arrived from a seller |
| `COUNTERING` | No | Active counter-offer exchange between buyer and seller |
| `ACCEPTED` | No | Both parties have signed the agreement |
| `ESCROWED` | No | USDC deposited into the Solana escrow vault |
| `ACTIVE` | No | Service delivery is in progress |
| `COMPLETED` | Yes | Service delivered successfully; escrow released to seller |
| `REJECTED` | Yes | Negotiation terminated by either party |
| `DISPUTED` | No | SLA violation filed; escrow frozen pending resolution |
| `RESOLVED` | Yes | Dispute settled; funds distributed according to outcome |

---

## Diagram

```
IDLE
  |
  | negotiate/rfq
  v
RFQ_SENT -----------------------> REJECTED
  |
  | negotiate/quote
  v
QUOTES_RECEIVED ----------------> REJECTED
  |              |
  | counter      | accept
  v              v
COUNTERING ---> ACCEPTED -------> REJECTED
  |   ^            |
  |   | counter    | escrow deposit
  |   |            v
  +---+         ESCROWED
  |                |
  | reject         | service starts
  v                v
REJECTED        ACTIVE
                |      |
                |      | negotiate/dispute
                |      v
                |   DISPUTED
                |      |
                |      | settlement
                v      v
           COMPLETED  RESOLVED
```

---

## Transition table

Every valid state transition, the message or event that triggers it, and the party responsible.

| From | To | Trigger | Initiated by |
|---|---|---|---|
| `IDLE` | `RFQ_SENT` | `negotiate/rfq` sent | Buyer |
| `RFQ_SENT` | `QUOTES_RECEIVED` | First `negotiate/quote` received | Seller |
| `QUOTES_RECEIVED` | `COUNTERING` | `negotiate/counter` sent | Buyer or Seller |
| `QUOTES_RECEIVED` | `ACCEPTED` | `negotiate/accept` sent | Buyer |
| `COUNTERING` | `COUNTERING` | Another `negotiate/counter` (within `max_rounds`) | Buyer or Seller |
| `COUNTERING` | `ACCEPTED` | `negotiate/accept` sent | Buyer |
| `ACCEPTED` | `ESCROWED` | Escrow deposit confirmed on-chain | Buyer |
| `ACCEPTED` | `REJECTED` | Counter-sign refused or accept revoked | Buyer or Seller |
| `ESCROWED` | `ACTIVE` | Service execution begins | Seller |
| `ACTIVE` | `COMPLETED` | Escrow released via `release_escrow` | Seller |
| `ACTIVE` | `DISPUTED` | `negotiate/dispute` filed | Buyer |
| `DISPUTED` | `RESOLVED` | Dispute settled via `dispute_escrow` | On-chain arbitration |
| `RFQ_SENT` | `REJECTED` | `negotiate/reject` sent | Buyer or Seller |
| `QUOTES_RECEIVED` | `REJECTED` | `negotiate/reject` sent | Buyer or Seller |
| `COUNTERING` | `REJECTED` | `negotiate/reject` sent | Buyer or Seller |

Any transition not listed above is invalid. Attempting an invalid transition throws an `OphirError` with code `OPHIR_004` (`INVALID_STATE_TRANSITION`), which is returned as JSON-RPC error code `-32000` with `data.ophir_code: "OPHIR_004"`. The session remains in its current state.

---

## Paths

### Happy path

The most common negotiation flow with no counter-offers.

```
IDLE -> RFQ_SENT -> QUOTES_RECEIVED -> ACCEPTED -> ESCROWED -> ACTIVE -> COMPLETED
```

1. Buyer calls `requestQuotes()`, which sends `negotiate/rfq`. Session enters `RFQ_SENT`.
2. Seller responds with `negotiate/quote`. Session enters `QUOTES_RECEIVED`.
3. Buyer calls `acceptQuote()`, which sends `negotiate/accept`. Session enters `ACCEPTED`.
4. Buyer deposits USDC via `make_escrow` on Solana. Session enters `ESCROWED`.
5. Seller begins service delivery. Session enters `ACTIVE`.
6. Seller calls `release_escrow` after successful delivery. Session enters `COMPLETED`.

### Counter-offer loop

When terms are not immediately acceptable, the parties negotiate.

```
QUOTES_RECEIVED -> COUNTERING -> COUNTERING -> ... -> ACCEPTED
```

- Buyer or seller sends `negotiate/counter`. Session enters `COUNTERING`.
- The other party responds with another `negotiate/counter`. Session stays in `COUNTERING` with an incremented round number.
- This continues up to `max_rounds` iterations (default: 5).
- At any point during countering, either party can send `negotiate/accept` to finalize the terms.
- If `max_rounds` is exceeded, the next counter-offer is rejected with error code `OPHIR_005`.

### Rejection

Any pre-escrow state can transition to `REJECTED`.

```
RFQ_SENT | QUOTES_RECEIVED | COUNTERING | ACCEPTED -> REJECTED
```

- Either party sends `negotiate/reject` with an optional reason.
- The `ACCEPTED → REJECTED` transition handles the case where the seller refuses to counter-sign or a party revokes acceptance before escrow is funded.
- Rejection is terminal. The session cannot be resumed or reopened.
- All pending quotes in the session are invalidated.

### Dispute path

After service delivery begins, the buyer can dispute SLA violations.

```
ACTIVE -> DISPUTED -> RESOLVED
```

1. Buyer files `negotiate/dispute` with violation evidence and optional Lockstep report.
2. Session enters `DISPUTED`. The escrow is frozen with `escrow_action: "freeze"`.
3. On-chain dispute resolution via `dispute_escrow` determines the outcome.
4. Session enters `RESOLVED`. Funds are distributed based on the ruling.

---

## Timeouts

Each state has an associated timeout. When a timeout expires, the behavior depends on the state.

| State | Timeout | Default | Behavior on expiry |
|---|---|---|---|
| `RFQ_SENT` | RFQ expiry | 5 minutes | Session transitions to `REJECTED` (no sellers responded) |
| `QUOTES_RECEIVED` | Quote expiry | 2 minutes | Individual quote is invalidated; other quotes may still be valid |
| `COUNTERING` | Counter expiry | 2 minutes | Counter-offer lapses; previous terms remain available |
| `ESCROWED` | Escrow timeout | Configurable (Solana slots) | Buyer may call `cancel_escrow` to reclaim funds |

Timeouts are checked using the `isExpired()` method on `NegotiationSession`, which compares the elapsed time since the last state transition against the timeout for the current state.

---

## Error handling

Invalid state transitions are handled deterministically:

- The SDK throws an `OphirError` with code `OPHIR_004` (`INVALID_STATE_TRANSITION`).
- The server maps this to JSON-RPC error code `-32000` with the Ophir code in `data.ophir_code`.
- The error message indicates the current state, the attempted target state, and the valid transitions.
- The session remains in its current state (invalid transitions are no-ops).
- The `OphirError` includes structured `data` with `currentState`, `targetState`, and `validTransitions` fields for programmatic handling.

```json
{
  "jsonrpc": "2.0",
  "id": "msg-007",
  "error": {
    "code": -32000,
    "message": "Cannot accept from state RFQ_SENT. Valid transitions: QUOTES_RECEIVED, REJECTED",
    "data": { "ophir_code": "OPHIR_004", "currentState": "RFQ_SENT", "targetState": "ACCEPTED", "validTransitions": ["QUOTES_RECEIVED", "REJECTED"] }
  }
}
```
