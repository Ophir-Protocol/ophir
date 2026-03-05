import { SellerAgent, MetricCollector } from '@ophirai/sdk';
import type { ServiceOffering, Agreement } from '@ophirai/sdk';
import type { RFQParams, QuoteParams } from '@ophirai/protocol';

/** Configuration for a provider wrapper. */
export interface ProviderConfig {
  /** API key for the provider (or from env). */
  apiKey?: string;
  /** Base URL for the provider's API. */
  baseUrl?: string;
  /** Port to listen on (default: 0 for random). */
  port?: number;
  /** Endpoint URL for this seller (auto-detected from port if not set). */
  endpoint?: string;
  /** Registry endpoints to register with. */
  registryEndpoints?: string[];
  /** Custom pricing overrides per model. */
  pricing?: Record<string, { input: number; output: number; unit: string }>;
}

/** Result of executing an inference request through the provider. */
export interface InferenceResult {
  /** The model's response content. */
  content: string;
  /** Model used. */
  model: string;
  /** Token usage. */
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Latency in milliseconds. */
  latencyMs: number;
  /** Raw provider response for advanced use. */
  raw?: unknown;
}

/** Abstract base class for provider wrappers. */
export abstract class BaseProvider {
  protected seller: SellerAgent;
  protected config: ProviderConfig;
  protected metrics: MetricCollector;
  protected agreements = new Map<string, Agreement>();
  protected activeJobs = new Map<string, { agreement: Agreement; startTime: number }>();

  /** Provider name (e.g. 'openai', 'anthropic'). */
  abstract readonly name: string;

  /** Models offered by this provider with default pricing. */
  abstract readonly models: Array<{
    id: string;
    name: string;
    category: string;
    inputPrice: number;   // per 1M tokens
    outputPrice: number;  // per 1M tokens
  }>;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.metrics = new MetricCollector({ agreement_id: '', agreement_hash: '' });
    // Defer buildServiceOfferings() to after subclass field initializers run.
    // Class fields are initialized after super() returns, so we use queueMicrotask
    // to ensure this.models is available.
    this.seller = null!;
    queueMicrotask(() => this.initSeller());
  }

  private initSeller(): void {
    if (this.seller) return;
    const services = this.buildServiceOfferings();
    this.seller = new SellerAgent({
      endpoint: this.config.endpoint ?? `http://localhost:${this.config.port ?? 0}`,
      services,
    });
    this.setupHandlers();
  }

  /** Ensure the seller agent is initialized (called before any seller access). */
  protected ensureSeller(): void {
    this.initSeller();
  }

  /** Build ServiceOffering[] from this provider's model catalog. */
  protected buildServiceOfferings(): ServiceOffering[] {
    return this.models.map((m) => ({
      category: m.category,
      description: `${m.name} via ${this.name}`,
      base_price: this.getPrice(m.id, 'input').toFixed(6),
      currency: 'USDC',
      unit: '1M_tokens',
      capacity: 100,
    }));
  }

  /** Get the price for a model (check overrides first, then defaults). */
  protected getPrice(modelId: string, type: 'input' | 'output'): number {
    const override = this.config.pricing?.[modelId];
    if (override) return type === 'input' ? override.input : override.output;
    const model = this.models.find((m) => m.id === modelId);
    return model ? (type === 'input' ? model.inputPrice : model.outputPrice) : 0;
  }

  /** Set up RFQ handler on the seller agent. */
  private setupHandlers(): void {
    this.seller.onRFQ(async (rfq: RFQParams) => {
      return this.handleRFQ(rfq);
    });
  }

  /** Handle an incoming RFQ — check if we can serve it, generate a quote. */
  protected handleRFQ(rfq: RFQParams): Promise<QuoteParams | null> {
    this.ensureSeller();
    return Promise.resolve(this.seller.generateQuote(rfq));
  }

  /** Execute an inference request through the actual provider API. Subclasses must implement. */
  abstract executeInference(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
  }): Promise<InferenceResult>;

  /** Start the provider's seller agent. */
  async start(): Promise<void> {
    this.ensureSeller();
    await this.seller.listen(this.config.port ?? 0);
  }

  /** Stop the provider. */
  async stop(): Promise<void> {
    this.ensureSeller();
    await this.seller.close();
  }

  /** Get the seller agent's endpoint. */
  getEndpoint(): string {
    this.ensureSeller();
    return this.seller.getEndpoint();
  }

  /** Get the seller agent's did:key. */
  getAgentId(): string {
    this.ensureSeller();
    return this.seller.getAgentId();
  }
}
