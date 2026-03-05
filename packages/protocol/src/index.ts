/**
 * @module @ophir/protocol
 *
 * Core protocol definitions for the Ophir Agent Negotiation Protocol.
 * Exports TypeScript interfaces, Zod validation schemas, error types,
 * protocol constants, JSON-RPC method names, and the SLA JSON Schema.
 */

// Message types and interfaces
export * from './types.js';

// Zod runtime validation schemas
export * from './schemas.js';

// SLA JSON Schema (draft 2020-12)
export { SLA_JSON_SCHEMA } from './sla-schema.js';

// Error codes and OphirError class
export * from './errors.js';

// Protocol defaults and configuration
export * from './constants.js';

// JSON-RPC method names
export * from './methods.js';

// State machine transition rules
export * from './state-machine.js';
