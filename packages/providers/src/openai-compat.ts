import type { InferenceResult } from './base.js';

export interface OpenAICompatChatResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAICompatErrorResponse {
  error: { message: string; type: string; code: string | null };
}

/** Shared fetch-with-retry for OpenAI-compatible APIs. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, init);
    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = response.headers.get('retry-after');
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delayMs));
      lastError = new Error(`Rate limited (attempt ${attempt + 1})`);
      continue;
    }
    return response;
  }
  throw lastError ?? new Error('Max retries exceeded');
}

/** Execute a chat completion against any OpenAI-compatible endpoint. */
export async function openaiCompatibleRequest(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  providerName: string;
}): Promise<InferenceResult> {
  const body = {
    model: params.model,
    messages: params.messages,
    stream: false as const,
    ...(params.temperature !== undefined && { temperature: params.temperature }),
    ...(params.max_tokens !== undefined && { max_tokens: params.max_tokens }),
  };

  const start = performance.now();
  const response = await fetchWithRetry(`${params.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const latencyMs = performance.now() - start;

  if (!response.ok) {
    const err = (await response.json()) as OpenAICompatErrorResponse;
    throw new Error(`${params.providerName} API error (${response.status}): ${err.error?.message ?? response.statusText}`);
  }

  const data = (await response.json()) as OpenAICompatChatResponse;

  return {
    content: data.choices[0]?.message?.content ?? '',
    model: data.model,
    usage: data.usage,
    latencyMs,
    raw: data,
  };
}
