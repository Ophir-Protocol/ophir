import {
  QuoteParamsSchema,
  CounterParamsSchema,
  AcceptParamsSchema,
  METHODS,
  DEFAULT_CONFIG,
  OphirError,
  OphirErrorCode,
} from '@ophirai/protocol';
import type {
  RFQParams,
  QuoteParams,
  CounterParams,
  ServiceRequirement,
  BudgetConstraint,
  SLARequirement,
  FinalTerms,
  ViolationEvidence,
} from '@ophirai/protocol';
import { generateKeyPair, publicKeyToDid, didToPublicKey } from './identity.js';
import { signMessage, verifyMessage, agreementHash } from './signing.js';
import { NegotiationServer } from './server.js';
import { NegotiationSession } from './negotiation.js';
import { JsonRpcClient } from './transport.js';
import { buildRFQ, buildCounter, buildAccept, buildReject, buildDispute } from './messages.js';
import { autoDiscover } from './registry.js';
import type { ClearinghouseManager } from '@ophirai/clearinghouse';
import type { EscrowConfig, RankingFunction, SellerInfo, Agreement, DisputeResult } from './types.js';

/** Configuration for creating a BuyerAgent. */
export interface BuyerAgentConfig {
  /** Optional Ed25519 keypair; auto-generated if omitted. */
  keypair?: { publicKey: Uint8Array; secretKey: Uint8Array };
  /** HTTP endpoint URL where this buyer listens for incoming quotes and counter-offers. */
  endpoint: string;
  /** Optional Solana escrow configuration for payment enforcement. */
  escrowConfig?: EscrowConfig;
  /** Optional Lockstep verification endpoint for SLA compliance monitoring. */
  lockstepEndpoint?: string;
  /** Optional registry endpoints for agent discovery. */
  registryEndpoints?: string[];
  /** Optional fallback endpoints for A2A discovery when registry is unavailable. */
  fallbackEndpoints?: string[];
  /** Optional clearinghouse for margin assessment and multilateral netting. */
  clearinghouse?: ClearinghouseManager;
}

/**
 * Buy-side negotiation agent. Sends RFQs, collects quotes, ranks them,
 * and accepts/counters/rejects offers. Verifies seller signatures on all
 * incoming messages.
 */
export class BuyerAgent {
  private keypair: { publicKey: Uint8Array; secretKey: Uint8Array };
  private agentId: string;
  private endpoint: string;
  private transport: JsonRpcClient;
  private server: NegotiationServer;
  private sessions = new Map<string, NegotiationSession>();
  private quoteListeners = new Map<string, Array<() => void>>();
  /** Tracks processed message IDs within the replay window to reject duplicate/replayed messages. */
  private seenMessageIds = new Map<string, number>();
  private registryEndpoints?: string[];
  private fallbackEndpoints?: string[];
  private clearinghouse?: ClearinghouseManager;

  constructor(config: BuyerAgentConfig) {
    this.keypair = config.keypair ?? generateKeyPair();
    this.agentId = publicKeyToDid(this.keypair.publicKey);
    this.endpoint = config.endpoint;
    this.registryEndpoints = config.registryEndpoints;
    this.fallbackEndpoints = config.fallbackEndpoints;
    this.clearinghouse = config.clearinghouse;
    this.transport = new JsonRpcClient();
    this.server = new NegotiationServer();
    this.registerHandlers();
  }

  /** Check if a message ID has already been processed (replay protection).
   * Records the ID if new; throws DUPLICATE_MESSAGE if already seen.
   * Periodically evicts entries older than the replay protection window. */
  private enforceNoDuplicate(messageId: string): void {
    const now = Date.now();
    // Evict expired entries (older than the replay window)
    const windowMs = DEFAULT_CONFIG.replay_protection_window_ms;
    for (const [id, ts] of this.seenMessageIds) {
      if (now - ts > windowMs) this.seenMessageIds.delete(id);
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

  /** Register JSON-RPC handlers for Quote, Counter, and Accept methods.
   * Each handler validates the message schema, verifies the sender's Ed25519
   * signature, checks expiration, enforces replay protection, and updates the session state. */
  private registerHandlers(): void {
    // Handle incoming quotes from sellers
    this.server.handle(METHODS.QUOTE, async (params: unknown) => {
      const quote = QuoteParamsSchema.parse(params);
      this.enforceNoDuplicate(quote.quote_id);
      const session = this.sessions.get(quote.rfq_id);
      if (!session) {
        throw new OphirError(
          OphirErrorCode.INVALID_MESSAGE,
          `Received quote for unknown RFQ ${quote.rfq_id}. Was this RFQ sent by this buyer?`,
        );
      }

      // Reject expired quotes
      if (quote.expires_at && new Date(quote.expires_at).getTime() < Date.now()) {
        throw new OphirError(
          OphirErrorCode.EXPIRED_MESSAGE,
          `Quote ${quote.quote_id} from ${quote.seller.agent_id} has expired at ${quote.expires_at}`,
        );
      }

      // Verify seller's signature before trusting the quote
      const { signature, ...unsigned } = quote;
      const sellerPubKey = didToPublicKey(quote.seller.agent_id);
      if (!verifyMessage(unsigned, signature, sellerPubKey)) {
        throw new OphirError(
          OphirErrorCode.INVALID_SIGNATURE,
          `Invalid signature on quote ${quote.quote_id} from ${quote.seller.agent_id}`,
        );
      }

      session.addQuote(quote);
      this.notifyQuoteListeners(quote.rfq_id);
      return { status: 'received', quote_id: quote.quote_id };
    });

    // Handle incoming counter-offers from sellers
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

      // Verify the sender is a known seller who submitted a quote in this session
      const knownSeller = session.quotes.some(
        (q) => q.seller.agent_id === counter.from.agent_id,
      );
      if (!knownSeller) {
        throw new OphirError(
          OphirErrorCode.INVALID_MESSAGE,
          `Counter from ${counter.from.agent_id} rejected: sender is not a known seller in this negotiation`,
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
      return { status: 'received', counter_id: counter.counter_id };
    });

    // Handle accept acknowledgment from sellers
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

      // Verify the agreement hash matches the final terms
      const expectedHash = agreementHash(accept.final_terms);
      if (expectedHash !== accept.agreement_hash) {
        throw new OphirError(
          OphirErrorCode.INVALID_SIGNATURE,
          `Agreement hash mismatch on incoming accept: expected ${expectedHash}, got ${accept.agreement_hash}`,
        );
      }

      // Verify the seller's signature on the accept message.
      // Match the seller by the accepting_message_id (quote_id),
      // falling back to the first quote if no match is found.
      const { buyer_signature: _bs, seller_signature, ...unsigned } = accept;
      const sellerQuote =
        session.quotes.find(q => q.quote_id === accept.accepting_message_id) ??
        session.quotes[0];
      if (!sellerQuote) {
        throw new OphirError(
          OphirErrorCode.INVALID_MESSAGE,
          `Cannot verify accept for agreement ${accept.agreement_id}: no matching quote found in session`,
        );
      }
      if (seller_signature) {
        const sellerPubKey = didToPublicKey(sellerQuote.seller.agent_id);
        if (!verifyMessage(unsigned, seller_signature, sellerPubKey)) {
          throw new OphirError(
            OphirErrorCode.INVALID_SIGNATURE,
            `Invalid seller signature on incoming accept for agreement ${accept.agreement_id}`,
          );
        }
      }

      return { status: 'acknowledged', agreement_id: accept.agreement_id };
    });
  }

  /** Resolve all pending waitForQuotes() promises for the given RFQ and clear the listener queue. */
  private notifyQuoteListeners(rfqId: string): void {
    const listeners = this.quoteListeners.get(rfqId);
    if (listeners) {
      for (const resolve of listeners) resolve();
      this.quoteListeners.set(rfqId, []);
    }
  }

  /** Discover seller agents matching a service category. Currently returns empty; use direct endpoints.
   * @param _query - Search criteria containing a service category and optional requirements
   * @returns An empty array (placeholder for future discovery integration)
   * @example
   * ```typescript
   * const sellers = await buyer.discover({ category: 'llm-inference' });
   * ```
   */
  async discover(query: {
    category: string;
    requirements?: Record<string, unknown>;
  }): Promise<SellerInfo[]> {
    const agents = await autoDiscover(query.category, {
      registries: this.registryEndpoints,
      fallbackEndpoints: this.fallbackEndpoints,
    });
    return agents.map((a) => ({
      agentId: a.agentId,
      endpoint: a.endpoint,
      services: a.services,
    }));
  }

  /** Send an RFQ to one or more sellers and return the negotiation session.
   * @param params - RFQ parameters including seller targets, service requirements, budget, and SLA
   * @param params.sellers - Seller endpoints (strings) or SellerInfo objects to receive the RFQ
   * @param params.service - The service requirement describing what the buyer needs
   * @param params.budget - Budget constraint with maximum price and currency
   * @param params.sla - Optional SLA requirements for the service
   * @param params.maxRounds - Optional maximum number of negotiation rounds
   * @param params.timeout - Optional TTL in milliseconds for the RFQ
   * @returns The newly created NegotiationSession tracking this RFQ
   * @throws {OphirError} When a non-network error occurs sending to a seller
   * @example
   * ```typescript
   * const session = await buyer.requestQuotes({
   *   sellers: ['http://seller:3000'],
   *   service: { category: 'llm-inference', params: {} },
   *   budget: { max_price_per_unit: '0.01', currency: 'USDC' },
   * });
   * ```
   */
  async requestQuotes(params: {
    sellers: string[] | SellerInfo[];
    service: ServiceRequirement;
    budget: BudgetConstraint;
    sla?: SLARequirement;
    maxRounds?: number;
    timeout?: number;
  }): Promise<NegotiationSession> {
    const rfqMessage = buildRFQ({
      buyer: { agent_id: this.agentId, endpoint: this.endpoint },
      service: params.service,
      budget: params.budget,
      sla: params.sla,
      maxRounds: params.maxRounds,
      ttlMs: params.timeout,
      secretKey: this.keypair.secretKey,
    });

    const rfq = rfqMessage.params;
    const session = new NegotiationSession(rfq, params.maxRounds);
    this.sessions.set(rfq.rfq_id, session);

    // Resolve seller endpoints
    const endpoints = params.sellers.map((s) =>
      typeof s === 'string' ? s : s.endpoint,
    );

    // Send RFQ to all sellers concurrently.
    // Network errors are caught so one unreachable seller doesn't block others.
    // Non-network errors (e.g. crypto, programming) are re-thrown.
    const sends = endpoints.map(async (endpoint) => {
      try {
        await this.transport.send(endpoint, METHODS.RFQ, rfq);
      } catch (err) {
        if (err instanceof OphirError && err.code === OphirErrorCode.SELLER_UNREACHABLE) {
          return; // expected — seller is unreachable, continue with others
        }
        throw err; // unexpected error — don't silently swallow
      }
    });
    await Promise.allSettled(sends);

    return session;
  }

  /** Wait for quotes to arrive, resolving when minQuotes are received or timeout elapses.
   * @param session - The negotiation session to wait on
   * @param options - Optional wait configuration
   * @param options.minQuotes - Minimum number of quotes before resolving (default: 1)
   * @param options.timeout - Maximum time to wait in milliseconds (default: 30000)
   * @returns Array of quotes received so far when the condition is met or timeout elapses
   * @example
   * ```typescript
   * const quotes = await buyer.waitForQuotes(session, { minQuotes: 2, timeout: 10000 });
   * ```
   */
  async waitForQuotes(
    session: NegotiationSession,
    options?: { minQuotes?: number; timeout?: number },
  ): Promise<QuoteParams[]> {
    const minQuotes = options?.minQuotes ?? 1;
    const timeout = options?.timeout ?? 30_000;

    if (session.quotes.length >= minQuotes) {
      return session.quotes;
    }

    return new Promise<QuoteParams[]>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(session.quotes);
      }, timeout);

      const check = () => {
        if (session.quotes.length >= minQuotes) {
          cleanup();
          resolve(session.quotes);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        const listeners = this.quoteListeners.get(session.rfqId);
        if (listeners) {
          const idx = listeners.indexOf(check);
          if (idx !== -1) listeners.splice(idx, 1);
        }
      };

      if (!this.quoteListeners.has(session.rfqId)) {
        this.quoteListeners.set(session.rfqId, []);
      }
      this.quoteListeners.get(session.rfqId)!.push(check);
    });
  }

  /** Sort quotes by a ranking strategy (cheapest, fastest, best_sla, or custom function).
   * @param quotes - Array of quotes to rank
   * @param strategy - Ranking strategy: 'cheapest', 'fastest', 'best_sla', or a custom comparator (default: 'cheapest')
   * @returns A new sorted array of quotes (best first)
   * @example
   * ```typescript
   * const ranked = buyer.rankQuotes(quotes, 'fastest');
   * const best = ranked[0];
   * ```
   */
  rankQuotes(
    quotes: QuoteParams[],
    strategy?: 'cheapest' | 'fastest' | 'best_sla' | RankingFunction,
  ): QuoteParams[] {
    const sorted = [...quotes];
    const resolvedStrategy = strategy ?? 'cheapest';

    if (typeof resolvedStrategy === 'function') {
      return sorted.sort(resolvedStrategy);
    }

    switch (resolvedStrategy) {
      case 'cheapest':
        return sorted.sort(
          (a, b) => parseFloat(a.pricing.price_per_unit) - parseFloat(b.pricing.price_per_unit),
        );

      case 'fastest':
        return sorted.sort((a, b) => {
          const aLatency = a.sla_offered?.metrics.find((m) => m.name === 'p99_latency_ms')?.target ?? Infinity;
          const bLatency = b.sla_offered?.metrics.find((m) => m.name === 'p99_latency_ms')?.target ?? Infinity;
          return aLatency - bLatency;
        });

      case 'best_sla':
        return sorted.sort((a, b) => {
          const scoreA = this.scoreSLA(a);
          const scoreB = this.scoreSLA(b);
          return scoreB - scoreA; // higher score = better
        });
    }
  }

  /** Compute a composite SLA quality score for ranking. Higher-is-better metrics (uptime, accuracy) add directly; lower-is-better metrics (latency, error rate) are inverted. */
  private scoreSLA(quote: QuoteParams): number {
    if (!quote.sla_offered) return 0;
    let score = 0;
    for (const metric of quote.sla_offered.metrics) {
      switch (metric.name) {
        case 'uptime_pct':
          score += metric.target;
          break;
        case 'accuracy_pct':
          score += metric.target;
          break;
        case 'p99_latency_ms':
        case 'p50_latency_ms':
        case 'time_to_first_byte_ms':
          // Lower is better — invert contribution
          score += 1000 / metric.target;
          break;
        case 'throughput_rpm':
          score += metric.target / 100;
          break;
        case 'error_rate_pct':
          score += (100 - metric.target);
          break;
        default:
          score += metric.target;
      }
    }
    return score;
  }

  /** Accept a quote, creating a signed agreement with the seller. Verifies the seller's signature first.
   * @param quote - The quote to accept, as received from a seller
   * @returns A dual-signed Agreement containing final terms and both party signatures
   * @throws {OphirError} When the seller's signature on the quote is invalid
   * @throws {OphirError} When the seller's counter-signature on the accept is invalid
   * @example
   * ```typescript
   * const agreement = await buyer.acceptQuote(quotes[0]);
   * console.log(agreement.agreement_id);
   * ```
   */
  async acceptQuote(quote: QuoteParams): Promise<Agreement> {
    // Verify seller's signature before trusting the quote
    const { signature, ...unsigned } = quote;
    const sellerPubKey = didToPublicKey(quote.seller.agent_id);
    if (!verifyMessage(unsigned, signature, sellerPubKey)) {
      throw new OphirError(
        OphirErrorCode.INVALID_SIGNATURE,
        `Cannot accept quote ${quote.quote_id}: seller signature is invalid`,
      );
    }

    const finalTerms: FinalTerms = {
      price_per_unit: quote.pricing.price_per_unit,
      currency: quote.pricing.currency,
      unit: quote.pricing.unit,
      sla: quote.sla_offered,
      escrow: quote.escrow_requirement
        ? {
            network: quote.escrow_requirement.type === 'solana_pda' ? 'solana' : quote.escrow_requirement.type,
            deposit_amount: quote.escrow_requirement.deposit_amount,
            release_condition: quote.escrow_requirement.release_condition,
          }
        : undefined,
    };

    // Build the accept without a seller_signature — the seller will
    // counter-sign the same unsigned payload to produce a proper dual-sig.
    const acceptMessage = buildAccept({
      rfqId: quote.rfq_id,
      acceptingMessageId: quote.quote_id,
      finalTerms,
      buyerSecretKey: this.keypair.secretKey,
    });

    const accept = acceptMessage.params;

    // Send accept to seller and capture their counter-signature.
    // The seller counter-signs the same unsigned accept data, producing a
    // proper dual-signature agreement where both parties sign the identical
    // canonical payload: {agreement_id, rfq_id, accepting_message_id,
    // final_terms, agreement_hash}.
    let sellerCounterSignature: string | undefined;
    try {
      const response = await this.transport.send<{
        status: string;
        agreement_id: string;
        seller_signature?: string;
      }>(quote.seller.endpoint, METHODS.ACCEPT, accept);

      if (response.seller_signature) {
        // Verify the seller's counter-signature before trusting it
        const { buyer_signature: _bs, seller_signature: _ss, ...unsignedAccept } = accept;
        if (!verifyMessage(unsignedAccept, response.seller_signature, sellerPubKey)) {
          throw new OphirError(
            OphirErrorCode.INVALID_SIGNATURE,
            `Seller counter-signature on accept for ${accept.agreement_id} is invalid`,
          );
        }
        sellerCounterSignature = response.seller_signature;
      }
    } catch (err) {
      if (err instanceof OphirError && err.code === OphirErrorCode.SELLER_UNREACHABLE) {
        // Seller unreachable — agreement proceeds without seller counter-signature.
        // The buyer_signature alone commits the buyer; the seller must counter-sign
        // before escrow is funded.
      } else {
        throw err;
      }
    }

    const agreement: Agreement = {
      agreement_id: accept.agreement_id,
      rfq_id: accept.rfq_id,
      accepting_message_id: accept.accepting_message_id,
      final_terms: accept.final_terms,
      agreement_hash: accept.agreement_hash,
      buyer_signature: accept.buyer_signature,
      seller_signature: sellerCounterSignature,
    };

    // Update session state
    const session = this.sessions.get(quote.rfq_id);
    if (session) {
      session.accept(agreement);

      // Clearinghouse: assess margin and register obligation
      if (this.clearinghouse) {
        const depositAmount = parseFloat(finalTerms.price_per_unit);
        const assessment = this.clearinghouse.assessMargin(
          {
            agreement_id: agreement.agreement_id,
            buyer_id: this.agentId,
            seller_id: quote.seller.agent_id,
          },
          depositAmount,
        );
        session.marginAssessed(assessment);

        if (this.clearinghouse.checkCircuitBreaker(this.agentId)) {
          throw new OphirError(
            OphirErrorCode.EXPOSURE_LIMIT_EXCEEDED,
            `Buyer ${this.agentId} has exceeded the clearinghouse exposure limit`,
            { agentId: this.agentId, agreementId: agreement.agreement_id },
          );
        }

        this.clearinghouse.registerObligation(
          agreement.agreement_id,
          this.agentId,
          quote.seller.agent_id,
          depositAmount,
        );
      }
    }

    return agreement;
  }

  /** Send a counter-offer proposing modified terms for a quote.
   * @param quote - The original quote to counter
   * @param modifications - Key-value map of proposed term changes (e.g., price, SLA targets)
   * @param justification - Optional human-readable reason for the counter-offer
   * @returns The updated NegotiationSession reflecting the new counter round
   * @throws {OphirError} When no active session exists for the quote's RFQ ID
   * @example
   * ```typescript
   * const session = await buyer.counter(quote, { price_per_unit: '0.008' }, 'Volume discount');
   * ```
   */
  async counter(
    quote: QuoteParams,
    modifications: Record<string, unknown>,
    justification?: string,
  ): Promise<NegotiationSession> {
    const session = this.sessions.get(quote.rfq_id);
    if (!session) {
      throw new OphirError(
        OphirErrorCode.INVALID_STATE_TRANSITION,
        `No active session for RFQ ${quote.rfq_id}. Call requestQuotes() first.`,
      );
    }

    const counterMessage = buildCounter({
      rfqId: quote.rfq_id,
      inResponseTo: quote.quote_id,
      round: session.currentRound + 1,
      from: { agent_id: this.agentId, role: 'buyer' },
      modifications,
      justification,
      secretKey: this.keypair.secretKey,
    });

    const counterParams = counterMessage.params;
    session.addCounter(counterParams);

    try {
      await this.transport.send(
        quote.seller.endpoint,
        METHODS.COUNTER,
        counterParams,
      );
    } catch (err) {
      if (!(err instanceof OphirError && err.code === OphirErrorCode.SELLER_UNREACHABLE)) {
        throw err;
      }
    }

    return session;
  }

  /** Reject all quotes in a session and notify sellers.
   * @param session - The negotiation session whose quotes should be rejected
   * @param reason - Optional rejection reason sent to all sellers (default: 'Rejected by buyer')
   * @returns Resolves when all rejection messages have been sent
   * @throws {OphirError} When a non-network error occurs notifying a seller
   * @example
   * ```typescript
   * await buyer.reject(session, 'Budget exceeded');
   * ```
   */
  async reject(session: NegotiationSession, reason?: string): Promise<void> {
    const rejectReason = reason ?? 'Rejected by buyer';

    // Collect all seller endpoints from received quotes
    const sellerEndpoints = new Set(
      session.quotes.map((q) => q.seller.endpoint),
    );

    const rejectMessage = buildReject({
      rfqId: session.rfqId,
      rejectingMessageId: session.rfqId,
      reason: rejectReason,
      agentId: this.agentId,
      secretKey: this.keypair.secretKey,
    });

    const sends = [...sellerEndpoints].map(async (endpoint) => {
      try {
        await this.transport.send(
          endpoint,
          METHODS.REJECT,
          rejectMessage.params,
        );
      } catch (err) {
        if (!(err instanceof OphirError && err.code === OphirErrorCode.SELLER_UNREACHABLE)) {
          throw err;
        }
      }
    });
    await Promise.allSettled(sends);

    session.reject(rejectReason);
  }

  /** File an SLA violation dispute against a seller for a given agreement.
   * @param agreement - The agreement under which the violation occurred
   * @param violation - Evidence of the SLA violation including metric name and observed value
   * @returns A DisputeResult with the dispute ID and initial 'pending' outcome
   * @throws {OphirError} When a non-network error occurs notifying the seller
   * @example
   * ```typescript
   * const result = await buyer.dispute(agreement, {
   *   metric: 'uptime_pct', observed: 95.0, threshold: 99.9,
   * });
   * ```
   */
  async dispute(
    agreement: Agreement,
    violation: ViolationEvidence,
  ): Promise<DisputeResult> {
    const disputeMessage = buildDispute({
      agreementId: agreement.agreement_id,
      filedBy: { agent_id: this.agentId, role: 'buyer' },
      violation,
      requestedRemedy: 'escrow_release',
      escrowAction: 'freeze',
      secretKey: this.keypair.secretKey,
    });

    // Find the session and seller endpoint from the agreement
    const session = this.sessions.get(agreement.rfq_id);
    const sellerEndpoint = session?.quotes.find(
      (q) => q.seller.agent_id !== this.agentId,
    )?.seller.endpoint;

    if (sellerEndpoint) {
      try {
        await this.transport.send(
          sellerEndpoint,
          METHODS.DISPUTE,
          disputeMessage.params,
        );
      } catch (err) {
        if (!(err instanceof OphirError && err.code === OphirErrorCode.SELLER_UNREACHABLE)) {
          throw err;
        }
      }
    }

    if (session) {
      session.dispute();
    }

    return {
      dispute_id: disputeMessage.params.dispute_id,
      outcome: 'pending',
    };
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

  /** Start the HTTP server to receive quotes and counter-offers.
   * @param port - Port number to listen on (default: 3001). Pass 0 for a random available port.
   * @returns Resolves when the server is listening
   * @example
   * ```typescript
   * await buyer.listen(0);
   * console.log(buyer.getEndpoint());
   * ```
   */
  async listen(port?: number): Promise<void> {
    await this.server.listen(port ?? 3001);
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
