import { v4 as uuidv4 } from 'uuid';
import {
  RFQParamsSchema,
  CounterParamsSchema,
  AcceptParamsSchema,
  RejectParamsSchema,
  METHODS,
  DEFAULT_CONFIG,
  OphirError,
  OphirErrorCode,
} from '@ophirai/protocol';
import type {
  RFQParams,
  QuoteParams,
  CounterParams,
  AcceptParams,
  RejectParams,
  SLARequirement,
} from '@ophirai/protocol';
import { generateKeyPair, publicKeyToDid, didToPublicKey } from './identity.js';
import { signMessage, verifyMessage, agreementHash } from './signing.js';
import { NegotiationServer } from './server.js';
import { NegotiationSession } from './negotiation.js';
import { JsonRpcClient } from './transport.js';
import type { ServiceOffering, PricingStrategy, Agreement } from './types.js';
import type { AgentCard } from './discovery.js';

/** Configuration for creating a SellerAgent. */
export interface SellerAgentConfig {
  /** Optional Ed25519 keypair; auto-generated if omitted. */
  keypair?: { publicKey: Uint8Array; secretKey: Uint8Array };
  /** HTTP endpoint URL where this seller listens for incoming JSON-RPC messages. */
  endpoint: string;
  /** Service offerings this seller advertises (category, price, SLA). */
  services: ServiceOffering[];
  /** Pricing strategy for quote generation (default: fixed). */
  pricingStrategy?: PricingStrategy;
}

/**
 * Sell-side negotiation agent. Receives RFQs, generates quotes, handles
 * counters, and manages agreements. Verifies buyer signatures on incoming
 * counter-offers.
 */
export class SellerAgent {
  private keypair: { publicKey: Uint8Array; secretKey: Uint8Array };
  private agentId: string;
  private endpoint: string;
  private services: ServiceOffering[];
  private pricingStrategy: PricingStrategy;
  private server: NegotiationServer;
  private sessions = new Map<string, NegotiationSession>();
  private transport = new JsonRpcClient();
  /** Tracks processed message IDs within the replay window to reject duplicate/replayed messages. */
  private seenMessageIds = new Map<string, number>();
  private rfqHandler?: (rfq: RFQParams) => Promise<QuoteParams | null>;
  private counterHandler?: (
    counter: CounterParams,
    session: NegotiationSession,
  ) => Promise<QuoteParams | 'accept' | 'reject'>;

  constructor(config: SellerAgentConfig) {
    this.keypair = config.keypair ?? generateKeyPair();
    this.agentId = publicKeyToDid(this.keypair.publicKey);
    this.endpoint = config.endpoint;
    this.services = [...config.services];
    this.pricingStrategy = config.pricingStrategy ?? { type: 'fixed' };

    this.server = new NegotiationServer();
    this.registerHandlers();
  }

  /** Check if a message ID has already been processed (replay protection).
   * Records the ID if new; throws DUPLICATE_MESSAGE if already seen.
   * Periodically evicts entries older than the replay protection window. */
  private enforceNoDuplicate(messageId: string): void {
    const now = Date.now();
    const windowMs = DEFAULT_CONFIG.replay_protection_window_ms;
    if (this.seenMessageIds.size > 1000) {
      for (const [id, ts] of this.seenMessageIds) {
        if (now - ts > windowMs) this.seenMessageIds.delete(id);
      }
    }
    if (this.seenMessageIds.has(messageId)) {
      throw new OphirError(
        OphirErrorCode.DUPLICATE_MESSAGE,
        `Duplicate message ID ${messageId} rejected (potential replay attack)`,
        { messageId },
      );
    }
    this.seenMessageIds.set(messageId, now);
  }

  /** Register JSON-RPC handlers for RFQ, Counter, Accept, and Reject methods.
   * Each handler validates the incoming message schema, verifies the sender's
   * Ed25519 signature, enforces replay protection, updates the session state,
   * and dispatches to user-provided callbacks (onRFQ, onCounter) when configured. */
  private registerHandlers(): void {
    this.server.handle(METHODS.RFQ, async (params: unknown) => {
      const rfq = RFQParamsSchema.parse(params);
      this.enforceNoDuplicate(rfq.rfq_id);

      // Reject expired RFQs
      if (rfq.expires_at && new Date(rfq.expires_at).getTime() < Date.now()) {
        throw new OphirError(
          OphirErrorCode.EXPIRED_MESSAGE,
          `RFQ ${rfq.rfq_id} from ${rfq.buyer.agent_id} has expired at ${rfq.expires_at}`,
        );
      }

      // Verify buyer's signature on the RFQ to prevent forgery.
      // Extract the buyer's public key from their DID and verify the signature
      // over the unsigned (signature-excluded) RFQ params.
      const { signature: rfqSignature, ...unsignedRfq } = rfq;
      const buyerPubKey = didToPublicKey(rfq.buyer.agent_id);
      if (!verifyMessage(unsignedRfq, rfqSignature, buyerPubKey)) {
        throw new OphirError(
          OphirErrorCode.INVALID_SIGNATURE,
          `Invalid signature on RFQ ${rfq.rfq_id} from ${rfq.buyer.agent_id}`,
        );
      }

      const session = new NegotiationSession(rfq);
      this.sessions.set(rfq.rfq_id, session);

      let quote: QuoteParams | null;
      if (this.rfqHandler) {
        quote = await this.rfqHandler(rfq);
        // Re-sign quotes from custom handlers to ensure cryptographic integrity.
        // Custom handlers may return quotes with placeholder signatures.
        if (quote) {
          const { signature: _sig, ...unsigned } = quote;
          const freshSignature = signMessage(unsigned, this.keypair.secretKey);
          quote = { ...unsigned, signature: freshSignature };
        }
      } else {
        quote = this.generateQuote(rfq);
      }

      if (!quote) return { status: 'ignored' };

      session.addQuote(quote);

      // Send quote back to buyer endpoint
      try {
        await this.transport.send(
          rfq.buyer.endpoint,
          METHODS.QUOTE,
          quote,
        );
      } catch (err) {
        if (!(err instanceof OphirError && err.code === OphirErrorCode.SELLER_UNREACHABLE)) {
          throw err;
        }
        // Buyer unreachable — quote is still stored in session
      }

      return quote;
    });

    this.server.handle(METHODS.COUNTER, async (params: unknown) => {
      const counter = CounterParamsSchema.parse(params);
      this.enforceNoDuplicate(counter.counter_id);
      const session = this.sessions.get(counter.rfq_id);
      if (!session) {
        throw new OphirError(
          OphirErrorCode.INVALID_MESSAGE,
          `Received counter for unknown RFQ ${counter.rfq_id}`,
        );
      }

      // Verify the counter sender is the buyer from the original RFQ
      if (counter.from.agent_id !== session.rfq.buyer.agent_id) {
        throw new OphirError(
          OphirErrorCode.INVALID_MESSAGE,
          `Counter from ${counter.from.agent_id} rejected: sender does not match RFQ buyer ${session.rfq.buyer.agent_id}`,
        );
      }

      // Reject expired counter-offers
      if (counter.expires_at && new Date(counter.expires_at).getTime() < Date.now()) {
        throw new OphirError(
          OphirErrorCode.EXPIRED_MESSAGE,
          `Counter ${counter.counter_id} from ${counter.from.agent_id} has expired at ${counter.expires_at}`,
        );
      }

      // Verify counter-party's signature
      const { signature, ...unsigned } = counter;
      const counterPubKey = didToPublicKey(counter.from.agent_id);
      if (!verifyMessage(unsigned, signature, counterPubKey)) {
        throw new OphirError(
          OphirErrorCode.INVALID_SIGNATURE,
          `Invalid signature on counter ${counter.counter_id} from ${counter.from.agent_id}`,
        );
      }

      session.addCounter(counter);

      if (this.counterHandler) {
        const result = await this.counterHandler(counter, session);
        if (result === 'accept') {
          return { status: 'accepted' };
        } else if (result === 'reject') {
          session.reject('Counter rejected by seller');
          return { status: 'rejected' };
        } else {
          // It's a new quote — re-sign to ensure cryptographic integrity
          const { signature: _sig, ...unsigned } = result;
          const freshSignature = signMessage(unsigned, this.keypair.secretKey);
          const signedQuote: QuoteParams = { ...unsigned, signature: freshSignature };
          session.addQuote(signedQuote);
          try {
            await this.transport.send(
              session.rfq.buyer.endpoint,
              METHODS.QUOTE,
              signedQuote,
            );
          } catch (err) {
            if (!(err instanceof OphirError && err.code === OphirErrorCode.SELLER_UNREACHABLE)) {
              throw err;
            }
          }
          return signedQuote;
        }
      }

      return { status: 'received' };
    });

    this.server.handle(METHODS.ACCEPT, async (params: unknown) => {
      const accept = AcceptParamsSchema.parse(params);
      this.enforceNoDuplicate(accept.agreement_id);
      const session = this.sessions.get(accept.rfq_id);
      if (!session) {
        throw new OphirError(
          OphirErrorCode.INVALID_MESSAGE,
          `Received accept for unknown RFQ ${accept.rfq_id}`,
        );
      }

      // Verify the accepting_message_id refers to a quote this seller sent
      const matchingQuote = session.quotes.find(
        (q) => q.quote_id === accept.accepting_message_id,
      );
      if (!matchingQuote) {
        throw new OphirError(
          OphirErrorCode.INVALID_MESSAGE,
          `Accept references message ${accept.accepting_message_id} which does not match any quote sent in this session`,
        );
      }

      // Verify the agreement hash matches the final terms
      const expectedHash = agreementHash(accept.final_terms);
      if (expectedHash !== accept.agreement_hash) {
        throw new OphirError(
          OphirErrorCode.INVALID_SIGNATURE,
          `Agreement hash mismatch: expected ${expectedHash}, got ${accept.agreement_hash}`,
        );
      }

      // Verify buyer's signature on the accept message
      const buyerDid = session.rfq.buyer.agent_id;
      const buyerPubKey = didToPublicKey(buyerDid);
      const { buyer_signature, seller_signature: _sellerSig, ...unsigned } = accept;
      if (!verifyMessage(unsigned, buyer_signature, buyerPubKey)) {
        throw new OphirError(
          OphirErrorCode.INVALID_SIGNATURE,
          `Invalid buyer signature on accept for agreement ${accept.agreement_id}`,
        );
      }

      // Seller counter-signs the same unsigned accept data, creating a proper
      // dual-signature agreement. Both buyer and seller sign the identical
      // canonical payload: {agreement_id, rfq_id, accepting_message_id,
      // final_terms, agreement_hash}.
      const sellerCounterSignature = signMessage(unsigned, this.keypair.secretKey);

      const agreement: Agreement = {
        agreement_id: accept.agreement_id,
        rfq_id: accept.rfq_id,
        accepting_message_id: accept.accepting_message_id,
        final_terms: accept.final_terms,
        agreement_hash: accept.agreement_hash,
        buyer_signature: accept.buyer_signature,
        seller_signature: sellerCounterSignature,
      };
      session.accept(agreement);
      return {
        status: 'accepted',
        agreement_id: accept.agreement_id,
        seller_signature: sellerCounterSignature,
      };
    });

    this.server.handle(METHODS.REJECT, async (params: unknown) => {
      const reject = RejectParamsSchema.parse(params);
      this.enforceNoDuplicate(`reject_${reject.rfq_id}_${reject.rejecting_message_id}`);
      const session = this.sessions.get(reject.rfq_id);
      if (!session) {
        throw new OphirError(
          OphirErrorCode.INVALID_MESSAGE,
          `Received reject for unknown RFQ ${reject.rfq_id}`,
        );
      }

      // Verify the rejecting agent's signature to prevent unauthorized rejections.
      const { signature: rejectSig, ...unsignedReject } = reject;
      const rejectPubKey = didToPublicKey(reject.from.agent_id);
      if (!verifyMessage(unsignedReject, rejectSig, rejectPubKey)) {
        throw new OphirError(
          OphirErrorCode.INVALID_SIGNATURE,
          `Invalid signature on reject for RFQ ${reject.rfq_id} from ${reject.from.agent_id}`,
        );
      }

      session.reject(reject.reason);
      return { status: 'rejected' };
    });
  }

  /** Register an additional service offering.
   * @param service - The service offering to add to this agent's catalog
   * @example
   * ```typescript
   * seller.registerService({ category: 'embedding', description: 'Text embeddings', base_price: '0.001', currency: 'USDC', unit: 'request' });
   * ```
   */
  registerService(service: ServiceOffering): void {
    this.services.push(service);
  }

  /** Generate an A2A-compatible Agent Card describing this seller's capabilities.
   * @returns An AgentCard object with this agent's services, endpoint, and negotiation metadata
   * @example
   * ```typescript
   * const card = seller.generateAgentCard();
   * console.log(card.capabilities.negotiation.services);
   * ```
   */
  generateAgentCard(): AgentCard {
    return {
      name: `Seller ${this.agentId.slice(-8)}`,
      description: 'Ophir-compatible seller agent',
      url: this.endpoint,
      capabilities: {
        negotiation: {
          supported: true,
          endpoint: this.endpoint,
          protocols: ['ophir/1.0'],
          acceptedPayments: [
            { network: DEFAULT_CONFIG.payment_network, token: DEFAULT_CONFIG.payment_token },
          ],
          negotiationStyles: ['rfq'],
          maxNegotiationRounds: DEFAULT_CONFIG.max_negotiation_rounds,
          services: this.services.map((s) => ({
            category: s.category,
            description: s.description,
            base_price: s.base_price,
            currency: s.currency,
            unit: s.unit,
          })),
        },
      },
    };
  }

  /** Set a custom handler for incoming RFQs. Return a QuoteParams to respond, or null to ignore.
   * @param handler - Async callback invoked for each incoming RFQ. Return a QuoteParams to send a quote, or null to ignore the RFQ.
   * @example
   * ```typescript
   * seller.onRFQ(async (rfq) => {
   *   if (rfq.budget.max_price_per_unit < '0.005') return null;
   *   return seller.generateQuote(rfq);
   * });
   * ```
   */
  onRFQ(handler: (rfq: RFQParams) => Promise<QuoteParams | null>): void {
    this.rfqHandler = handler;
  }

  /** Generate a signed quote for an RFQ based on matching services and pricing strategy.
   * @param rfq - The incoming RFQ to generate a quote for
   * @returns A signed QuoteParams if a matching service is found, or null if no service matches
   * @example
   * ```typescript
   * const quote = seller.generateQuote(rfq);
   * if (quote) console.log(quote.pricing.price_per_unit);
   * ```
   */
  generateQuote(rfq: RFQParams): QuoteParams | null {
    const service = this.services.find((s) => s.category === rfq.service.category);
    if (!service) return null;

    let pricePerUnit: number;
    const basePrice = parseFloat(service.base_price);
    if (Number.isNaN(basePrice)) {
      return null; // Invalid base price — cannot generate a quote
    }

    switch (this.pricingStrategy.type) {
      case 'competitive':
        pricePerUnit = basePrice * 0.9;
        break;
      case 'dynamic':
        pricePerUnit = basePrice;
        break;
      case 'fixed':
      default:
        pricePerUnit = basePrice;
        break;
    }

    const sla: SLARequirement = {
      metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
        { name: 'accuracy_pct', target: 95, comparison: 'gte' },
      ],
      dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
    };

    const unsigned = {
      quote_id: uuidv4(),
      rfq_id: rfq.rfq_id,
      seller: {
        agent_id: this.agentId,
        endpoint: this.endpoint,
      },
      pricing: {
        price_per_unit: pricePerUnit.toFixed(4),
        currency: service.currency,
        unit: service.unit,
        pricing_model: 'fixed' as const,
        volume_discounts: [
          { min_units: 1000, price_per_unit: (pricePerUnit * 0.9).toFixed(4) },
          { min_units: 10000, price_per_unit: (pricePerUnit * 0.8).toFixed(4) },
        ],
      },
      sla_offered: sla,
      expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
    };

    const signature = signMessage(unsigned, this.keypair.secretKey);
    return { ...unsigned, signature };
  }

  /** Set a custom handler for incoming counter-offers. Return a new QuoteParams, 'accept', or 'reject'.
   * @param handler - Async callback invoked for each counter-offer. Return a new QuoteParams to continue negotiation, 'accept' to agree, or 'reject' to end.
   * @example
   * ```typescript
   * seller.onCounter(async (counter, session) => {
   *   if (session.currentRound >= 3) return 'accept';
   *   return 'reject';
   * });
   * ```
   */
  onCounter(
    handler: (
      counter: CounterParams,
      session: NegotiationSession,
    ) => Promise<QuoteParams | 'accept' | 'reject'>,
  ): void {
    this.counterHandler = handler;
  }

  /** Start the HTTP server and begin accepting RFQs.
   * @param port - Port number to listen on (default: 3000). Pass 0 for a random available port.
   * @returns Resolves when the server is listening
   * @example
   * ```typescript
   * await seller.listen(0);
   * console.log(seller.getEndpoint());
   * ```
   */
  async listen(port?: number): Promise<void> {
    await this.server.listen(port ?? 3000);
    const boundPort = this.server.getPort();
    if (boundPort !== undefined) {
      const url = new URL(this.endpoint);
      url.port = String(boundPort);
      this.endpoint = url.toString().replace(/\/$/, '');
    }
  }

  /** Stop the HTTP server and close all connections.
   * @returns Resolves when the server has been shut down
   */
  async close(): Promise<void> {
    await this.server.close();
  }

  /** Get a negotiation session by its RFQ ID.
   * @param rfqId - The RFQ identifier to look up
   * @returns The matching NegotiationSession, or undefined if not found
   */
  getSession(rfqId: string): NegotiationSession | undefined {
    return this.sessions.get(rfqId);
  }

  /** Get all active negotiation sessions.
   * @returns Array of all NegotiationSession instances tracked by this agent
   */
  getSessions(): NegotiationSession[] {
    return [...this.sessions.values()];
  }

  /** Get this agent's did:key identifier.
   * @returns The agent's decentralized identifier (did:key)
   */
  getAgentId(): string {
    return this.agentId;
  }

  /** Get this agent's HTTP endpoint URL.
   * @returns The endpoint URL string (updated after listen() binds a port)
   */
  getEndpoint(): string {
    return this.endpoint;
  }
}
