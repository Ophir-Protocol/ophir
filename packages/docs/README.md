# Ophir Documentation

Documentation index for the Ophir Agent Negotiation Protocol -- a structured
protocol enabling autonomous agents to discover, negotiate, and transact
services with enforceable guarantees.

## Quick Install

```bash
npm install @ophir/sdk @ophir/protocol
```

## Table of Contents

### Overview

- [What is Ophir](./index.md) -- Project introduction and motivation
- [Quickstart](./quickstart.md) -- Get up and running in minutes

### Concepts

Core ideas behind the protocol and how the pieces fit together.

- [How It Works](./concepts/how-it-works.md) -- End-to-end negotiation flow
- [SLA Schema](./concepts/sla-schema.md) -- Defining service-level agreements
- [Escrow](./concepts/escrow.md) -- Payment guarantees and settlement
- [Identity](./concepts/identity.md) -- Agent identity, keys, and trust

### SDK Reference

Programmatic interfaces for building on Ophir.

- [Buyer API](./sdk/buyer.md) -- Discovering and purchasing services
- [Seller API](./sdk/seller.md) -- Listing and fulfilling services
- [Messages](./sdk/messages.md) -- Message types and serialization

### Protocol Specification

Formal definitions for implementors and auditors.

- [Specification](./protocol/specification.md) -- Full protocol specification
- [State Machine](./protocol/state-machine.md) -- Negotiation state transitions

## Documentation Structure

The docs are organized into three sections:

**Concepts** covers the design rationale and mental models you need before
writing code. Start here if you are new to Ophir.

**SDK Reference** documents the TypeScript packages (`@ophir/sdk` and
`@ophir/protocol`) with usage examples and API details.

**Protocol Specification** contains the formal, implementation-agnostic
definition of the negotiation protocol, intended for anyone building a
compatible client or verifying correctness.

## Project Overview

See the [root README](../../README.md) for repository structure, development
setup, and contribution guidelines.
