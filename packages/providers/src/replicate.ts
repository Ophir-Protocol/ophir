import { BaseProvider } from './base.js';
import type { ProviderConfig, InferenceResult } from './base.js';
import { fetchWithRetry } from './openai-compat.js';

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output: unknown;
  error: string | null;
  metrics?: { predict_time?: number };
}

export class ReplicateProvider extends BaseProvider {
  readonly name = 'replicate';
  readonly models = [
    { id: 'meta/llama-3-70b-instruct', name: 'Llama 3 70B (Replicate)', category: 'inference', inputPrice: 0.65, outputPrice: 2.75 },
    { id: 'stability-ai/sdxl', name: 'SDXL (Replicate)', category: 'image_generation', inputPrice: 0.002, outputPrice: 0 },
    { id: 'meta/meta-llama-3-8b-instruct', name: 'Llama 3 8B (Replicate)', category: 'inference', inputPrice: 0.05, outputPrice: 0.25 },
  ];

  private pollIntervalMs = 1000;
  private maxPollAttempts = 120;

  constructor(config: ProviderConfig = {}) {
    super(config);
  }

  async executeInference(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
  }): Promise<InferenceResult> {
    const apiKey = this.config.apiKey ?? process.env.REPLICATE_API_TOKEN;
    if (!apiKey) throw new Error('Replicate API token required (config.apiKey or REPLICATE_API_TOKEN env)');

    const baseUrl = this.config.baseUrl ?? 'https://api.replicate.com/v1';
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    const prompt = params.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    const input: Record<string, unknown> = { prompt };
    if (params.temperature !== undefined) input.temperature = params.temperature;
    if (params.max_tokens !== undefined) input.max_tokens = params.max_tokens;

    const start = performance.now();

    // Create prediction
    const createResponse = await fetchWithRetry(`${baseUrl}/predictions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: params.model, input }),
    });

    if (!createResponse.ok) {
      const err = await createResponse.text();
      throw new Error(`Replicate API error (${createResponse.status}): ${err}`);
    }

    let prediction = (await createResponse.json()) as ReplicatePrediction;

    // Poll until completed
    for (let i = 0; i < this.maxPollAttempts; i++) {
      if (prediction.status === 'succeeded' || prediction.status === 'failed' || prediction.status === 'canceled') {
        break;
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));

      const pollResponse = await fetch(`${baseUrl}/predictions/${prediction.id}`, { headers });
      if (!pollResponse.ok) {
        throw new Error(`Replicate poll error (${pollResponse.status}): ${await pollResponse.text()}`);
      }
      prediction = (await pollResponse.json()) as ReplicatePrediction;
    }

    const latencyMs = performance.now() - start;

    if (prediction.status === 'failed') {
      throw new Error(`Replicate prediction failed: ${prediction.error ?? 'unknown error'}`);
    }
    if (prediction.status !== 'succeeded') {
      throw new Error(`Replicate prediction timed out (status: ${prediction.status})`);
    }

    // Output can be a string, array of strings, or array of URLs (for image models)
    const output = prediction.output;
    const content = Array.isArray(output) ? output.join('') : String(output ?? '');

    this.metrics.record('p99_latency_ms', latencyMs);

    return {
      content,
      model: params.model,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latencyMs,
      raw: prediction,
    };
  }
}
